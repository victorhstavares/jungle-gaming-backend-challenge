# Arquitetura

Serviço que processa transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas por HTTP e por SQS e continua correto com mensagens duplicadas, fora de ordem, concorrentes, várias instâncias e quedas de processo ou de banco. As decisões estão resumidas aqui; cada uma tem um ADR em [`docs/adr/`](docs/adr) com contexto e alternativas.

## 1. Visão geral

```
              ┌────────────┐   client credentials   ┌──────────┐
 provider ───▶│   nginx    │◀──────── token ─────────│ Keycloak │
 back office  └─────┬──────┘                         └────┬─────┘
                    │ round robin                         │ JWKS (cache)
        ┌───────────┼───────────┐                         │
        ▼           ▼           ▼                         │
     app-1        app-2        app-3   ◀───────────────────┘
   (api, consumer, outbox, pending-reference: qualquer combinação por APP_ROLES)
        │  ▲        │           │
        │  │ SQS    ▼           ▼
        │  └── wager-transactions.fifo ──▶ DLQ (wager-transactions-dlq.fifo)
        ▼
     PostgreSQL ── outbox ──▶ wallet-events.fifo
```

Uma única imagem roda qualquer subconjunto dos papéis: API HTTP, consumidor da fila, publicador da outbox e worker de referências pendentes. No compose, as três instâncias rodam todos os papéis atrás do nginx.

### Camadas

```
src/
  domain/          Money, Wallet, WagerTransaction, lançamentos, Inbox/Outbox, eventos, regras (puro, sem framework)
  application/     casos de uso e portas (repositórios, transação, identidade, publicador, métricas)
  infrastructure/  MikroORM e migrations, SQS, verificação de JWT, logger, métricas
  interface/       controllers HTTP, consumidor SQS, workers
```

As dependências só apontam para dentro. O domínio não importa Nest, MikroORM nem o driver do Postgres. A aplicação conhece apenas portas, e a tradução de erros do Postgres para erros da aplicação acontece no `TransactionRunner` da infraestrutura. Os construtores são privados, com factories `create`/`open` que validam e `rehydrate` que reconstrói o estado persistido sem revalidar transições.

## 2. Fluxo de uma aposta

O caso de uso `ProcessWagerTransaction` é o único caminho para aplicar uma aposta, vinda do HTTP, do SQS ou do worker. Tudo acontece numa transação SQL:

1. Se a entrada é a fila: `INSERT` na inbox com `ON CONFLICT DO NOTHING`. Se a linha já existe, é redelivery: responde `DUPLICATE_MESSAGE`. Um `messageId` reaproveitado com outro conteúdo vai para a DLQ.
2. `SELECT ... FOR UPDATE` na wallet. Daqui em diante, ninguém mais altera esta wallet até o commit.
3. Busca por `(provider_id, idempotency_key)` e por `(provider_id, external_transaction_id)`. O mesmo hash de payload responde replay com o resultado gravado. Hash ou key diferentes respondem 409.
4. Resolve a referência por `(providerId, referenceExternalTransactionId)` e decide com a função pura `decide()`: aplicar débito ou crédito, sem efeito (LOSS), rejeitar com um `FailureCode`, ou aguardar a referência.
5. Grava a transação, atualiza o saldo, insere as duas pernas do ledger, os eventos na outbox, a marca da inbox e a linha de auditoria. Se a transação foi processada, as reversões que esperavam por ela ficam elegíveis na hora.
6. Commit. Só depois disso a resposta HTTP sai ou a mensagem recebe ack.

Um erro permanente de infraestrutura (trigger de integridade, overflow de `bigint`) faz rollback; a transação é então registrada como `FAILED` numa segunda transação, sem efeito no saldo, com evento e auditoria. Um erro não classificado é devolvido ao chamador para retry com a mesma key; ele nunca vira um `FAILED` terminal, que poderia perder uma aposta válida.

## 3. ORM e estratégia transacional

MikroORM 7, com `@mikro-orm/postgresql`, a opção preferida no enunciado.

- `em.transactional()` delimita cada caso de uso; `LockMode.PESSIMISTIC_WRITE` faz o lock da wallet e o da transação pendente.
- Os registros de persistência (`WalletRecord`, `WagerTransactionRecord`) ficam separados dos agregados de domínio, e os repositórios mapeiam explicitamente nos dois sentidos. As escritas usam `em.insert` e `em.nativeUpdate`, em vez de deixar o Unit of Work descobrir mudanças no flush: no caminho do dinheiro, cada comando SQL fica visível e determinístico. As leituras usam `disableIdentityMap` para nunca ver uma entidade em cache com saldo antigo.
- `SKIP LOCKED`, `ON CONFLICT` e o claim com lease usam `em.execute` com SQL explícito, porque o query builder não expressa essas cláusulas com clareza.
- Migrations versionadas, reversíveis e listadas explicitamente (`migrationsList`). O teste `migrate up → down → up` roda em toda execução da suíte.

Transação: `READ COMMITTED`, com `SET LOCAL lock_timeout = '5s'`, `statement_timeout = '10s'` e `app.correlation_id`. No cliente, `connectionTimeoutMillis` de 3 s e `query_timeout` de 12 s: um servidor congelado não consegue aplicar o `statement_timeout`, e sem esses limites a requisição ficaria pendurada. A ordem de lock é sempre wallet, depois transação. Ver ADR 0002.

## 4. Money

`Money` é imutável e guarda `bigint` de centavos mais o código ISO-4217. A entrada aceita somente string com exatamente duas casas (`^(0|[1-9][0-9]{0,14})\.[0-9]{2}$`) e nunca arredonda. No banco, valor e moeda ocupam colunas separadas (`amount_minor bigint`, `currency char(3)`), e o MikroORM mapeia `bigint` no modo `bigint` nativo, sem passar por `number`. Operações entre moedas diferentes lançam erro de domínio. Ver ADR 0001.

## 5. Schema

| Tabela | Papel |
|---|---|
| `wallets` | saldo materializado e versão |
| `wager_transactions` | cada operação, seu status, código de falha, saldo observado e tentativas |
| `ledger_entries` | partidas dobradas: perna `WALLET` com saldo antes e depois, e contrapartida sem saldo corrente |
| `inbox_messages` | deduplicação do consumidor por `(consumer_name, message_id)` |
| `outbox_messages` | eventos a publicar, com tentativas, lease e último erro |
| `wager_transaction_status_history` | toda transição de status, gravada por trigger |
| `audit_log` | toda tentativa e seu resultado |
| `reconciliation_runs` | toda reconciliação |

As garantias estão no banco: CHECKs de saldo não negativo e de aritmética dos lançamentos, UNIQUEs de idempotência e de wallet, índice único parcial de reversão, triggers de imutabilidade, de status terminal e de versão, e constraint triggers adiadas que exigem no commit que o saldo bata com o ledger e que as partidas fechem. A lista completa, invariante por invariante, está no ADR 0008. Índices parciais sustentam as consultas quentes: pendências por `next_attempt_at`, outbox pendente por `(next_attempt_at, occurred_at)` e por agregado, e ledger por `(wallet_id, seq)`.

## 6. Idempotência

- O header `Idempotency-Key` é obrigatório: de 1 a 256 caracteres ASCII imprimíveis, único por provider.
- `payloadHash` = SHA-256 em hex de `canonicalJson(campos de negócio)`. O JSON canônico ordena as chaves recursivamente, não tem espaços e omite propriedades indefinidas. Os campos são `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. O header e os metadados de transporte não entram no hash.
- Uma requisição idêntica recebe o resultado gravado, com `idempotentReplay: true`, incluindo o saldo visto na época. Se a original ficou pendente de referência e já assentou, o replay mostra o estado atual.
- A mesma key com outro payload, ou o mesmo id externo com outra key, responde 409 `IDEMPOTENCY_CONFLICT` e fica auditado.

Ver ADR 0003.

## 7. Processamento por SQS

- O consumidor faz long polling de 20 s em `wager-transactions.fifo` (`MessageGroupId` = wallet) e reutiliza o mesmo caso de uso do HTTP.
- O delete da mensagem só acontece depois do commit.
- Mensagens do mesmo grupo seguem em ordem, e grupos diferentes rodam em paralelo. Se uma mensagem volta para retry, as seguintes do grupo esperam por ela.

| Situação | Ação |
|---|---|
| Transação gravada (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, `FAILED`) ou redelivery | delete (ack) |
| Postgres indisponível, lock timeout, conexão perdida | visibilidade com backoff `min(2^n, 60)` s |
| Wallet inexistente (pode ser criada logo depois) | mesmo backoff |
| JSON ou contrato inválido, conflito de idempotência, `messageId` reaproveitado | DLQ com atributos `reason` e `code`, delete e auditoria |
| 10 recebimentos sem sucesso | DLQ com o motivo |

No SIGTERM o processo para de buscar, termina as mensagens em andamento, devolve as não iniciadas com visibilidade 0, fecha o banco e sai com código 0. Ver ADR 0005.

## 8. Outbox e eventos

Os eventos entram na outbox na mesma transação da mudança. O publicador:

1. Pega um lote com `FOR UPDATE SKIP LOCKED` e um lease de 30 s, numa transação curta que comita antes de chamar o SQS.
2. Envia em `SendMessageBatch` de 10, com `MessageGroupId` = agregado e `MessageDeduplicationId` = id do evento.
3. Marca o lote com um único `UPDATE`.

Só o evento pendente mais antigo de cada agregado pode ser pego, para que os eventos de uma wallet saiam na ordem dos commits. Os timestamps são lidos sob o lock da wallet; com relógios das instâncias sincronizados (NTP), seguem a ordem dos commits, e o `walletVersion` dos eventos de saldo permite ao consumidor ordenar mesmo se não estiverem. Uma falha reagenda o evento com backoff de até 5 min, sem descartá-lo. Se o publicador morrer depois de publicar e antes de marcar, o lease expira e outro publica de novo; o consumidor descarta a repetição pelo `eventId`. Ver ADR 0004.

| Evento | Quando |
|---|---|
| `WagerTransactionProcessed` | toda transação aplicada, LOSS inclusive |
| `WagerTransactionRejected` | `REJECTED` por regra de negócio e `FAILED`; o campo `status` distingue |
| `WalletBalanceChanged` | somente quando o saldo muda, com `walletVersion` |
| `WagerTransactionPendingReference` | referência ausente |
| `WalletOpened` | abertura de wallet |

O envelope é uma classe abstrata `IntegrationEvent<T>` com `eventType` e `version` definidos em cada subclasse; `data` carrega `MoneyProps` (string decimal), nunca a instância de `Money`.

## 9. Referências fora de ordem

Um REFUND ou ROLLBACK cuja referência ainda não chegou (ou ainda não é terminal) é gravado como `PENDING_REFERENCE`, com evento e resposta 202. Ele é resolvido de duas formas:

- Na hora: quando a referência é processada, as pendências que dependem dela ficam elegíveis no mesmo commit.
- Pelo worker: ele pega as pendências vencidas com `SKIP LOCKED`, comita esse claim e só então reprocessa, no máximo quatro por vez. Assim nunca segura linhas pendentes enquanto espera o lock de uma wallet.

O backoff é de 1 s·2ⁿ, até 5 min, em no máximo 10 tentativas, o que dá cerca de 13,5 minutos. Os provedores mandam a operação referenciada em segundos, então um atraso maior que esse indica referência perdida. Esgotadas as tentativas, a transação vira `REJECTED`:
- `REFERENCE_NOT_FOUND` se a referência nunca apareceu;
- `REFERENCE_NOT_PROCESSED` se a referência existe mas nunca assentou.

Cada tentativa fica auditada.

## 10. API HTTP

| Situação | Status | Corpo |
|---|---|---|
| Transação nova processada, wallet criada | 201 | resultado |
| Replay idêntico | status do estado gravado | resultado com `idempotentReplay: true`; uma operação que estava pendente e já assentou responde o estado atual |
| Aguardando referência | 202 | resultado com `status: PENDING_REFERENCE` |
| Payload, valor, cursor ou id inválido, header ausente | 400 | problem+json |
| Sem token ou token inválido | 401 | problem+json |
| Papel insuficiente ou outro provider | 403 | problem+json |
| Wallet, transação ou rota inexistente | 404 | problem+json |
| Conflito de idempotência, wallet duplicada | 409 | problem+json |
| Corpo acima de 64 KB | 413 | problem+json (acima de 1 MB, o nginx responde antes da aplicação) |
| Rejeição de negócio (`REJECTED` gravado) | 422 | resultado com `failureCode` |
| Erro permanente gravado como `FAILED` | 500 | resultado com `failureCode: PROCESSING_FAILED`; é resposta final, e o replay devolve o mesmo corpo |
| Falha transitória de infraestrutura | 503 + `Retry-After: 1` | problem+json |

Os erros seguem o RFC 9457 (`application/problem+json`), com `code` estável e `correlationId`. O cursor do ledger é o base64url da sequência do último lançamento: opaco para o cliente e estável sob novas inserções, porque os lançamentos de uma wallet são gravados sob o lock dela, em ordem.

## 11. Códigos de falha

Gravados na transação:

| Código | Quando | O que o provider faz |
|---|---|---|
| `INSUFFICIENT_FUNDS` | BET maior que o saldo | resposta final; não reenviar |
| `REVERSAL_INSUFFICIENT_FUNDS` | ROLLBACK de WIN ou REFUND sem saldo para debitar | resposta final; tratar manualmente |
| `CURRENCY_MISMATCH` | moeda da operação diferente da wallet | corrigir e enviar com novo id externo |
| `PLAYER_WALLET_MISMATCH` | jogador não é dono da wallet | corrigir e enviar com novo id externo |
| `REFERENCE_MISMATCH` | referência de outro provider, jogador, wallet, moeda ou rodada | corrigir |
| `REFERENCE_KIND_NOT_REVERSIBLE` | REFUND de algo que não é BET; ROLLBACK de LOSS, OPENING ou ROLLBACK | corrigir |
| `AMOUNT_MISMATCH` | reversão com valor diferente da referência | corrigir |
| `REFERENCE_ALREADY_REVERSED` | a referência já foi revertida | desistir: o efeito já aconteceu |
| `REFERENCE_NOT_PROCESSED` | a referência foi rejeitada, falhou ou nunca assentou | desistir |
| `REFERENCE_NOT_FOUND` | a referência não chegou em cerca de 13,5 min | enviar a referência e depois uma nova reversão |
| `PROCESSING_FAILED` | erro permanente de infraestrutura (`FAILED`) | contatar a operação; reenviar com novo id externo |

Recusados no contrato, sem transação gravada, mas auditados: `INVALID_PAYLOAD`, `INVALID_MONEY`, `UNSUPPORTED_CURRENCY`, `OPENING_NOT_ALLOWED` e `MISSING_IDEMPOTENCY_KEY` (corrigir e reenviar), `IDEMPOTENCY_CONFLICT` (não reenviar; usar outra key para outra operação), `WALLET_NOT_FOUND` (corrigir), `TEMPORARILY_UNAVAILABLE` (reenviar a mesma requisição) e `MESSAGE_ID_REUSED` (só na fila; vai para a DLQ).

## 12. Autenticação e autorização

O Keycloak emite tokens por client credentials, e a API valida o JWT localmente pelo JWKS com cache. O papel `provider` só age pelo próprio `provider_id`: corpo de outro provider responde 403, e transação de outro provider responde 404, para não revelar que ela existe. O papel `operator` cria wallets, lê o ledger e reconcilia. Health e métricas são abertos. A API só depende da porta `IdentityVerifier`, então trocar de provedor de identidade não muda o código dela. Ver ADR 0009.

## 13. Auditoria

Toda tentativa que muda estado tem uma linha em `audit_log` com o resultado e o motivo, inclusive conflitos, erros de contrato, wallets inexistentes, mensagens enviadas à DLQ e falhas permanentes. Toda mudança de status fica em `wager_transaction_status_history`, gravada por trigger com o correlation id. Toda reconciliação fica em `reconciliation_runs`. As três tabelas só aceitam inserção. Ver ADR 0010.

## 14. Observabilidade

- Logs: JSON (pino) com `correlationId` (propagado via `AsyncLocalStorage` e devolvido no header `X-Correlation-Id`), `messageId`, `transactionId`, `walletId`, `providerId`, `kind`, `status` e `failureCode`. Tokens, segredos, corpos e payloads são redigidos, e os logs de rotina não carregam valores. A exceção é a mensagem de um erro de integridade do banco, que pode citar o saldo envolvido.
- Métricas (Prometheus, `GET /metrics`):

| Métrica | Mede |
|---|---|
| `wager_transactions_total{kind,status}` | transações por resultado |
| `idempotent_replays_total`, `inbox_duplicates_total` | duplicatas detectadas |
| `idempotency_conflicts_total` | keys reaproveitadas com outro payload |
| `sqs_retries_total{reason}`, `sqs_dlq_total{reason}` | retries e mensagens na DLQ |
| `wallet_lock_wait_seconds`, `wallet_lock_timeouts_total` | espera e conflitos de lock |
| `outbox_lag_seconds`, `outbox_publish_failures_total` | atraso da outbox |
| `wager_processing_seconds{source}` | latência de processamento |
| `reconciliation_mismatches_total`, `audit_write_failures_total`, `auth_failures_total{reason}`, `processing_failures_total` | sinais de alarme |

- Health: `/health/live` responde se o processo está vivo; `/health/ready` verifica Postgres (`SELECT 1`) e SQS (`GetQueueAttributes`), cada um com limite de 2 s, e responde 503 com o detalhe de cada verificação.

## 15. Como os testes provam as garantias

Todos os testes de integração e concorrência usam Postgres e LocalStack reais, e todos terminam conferindo que o saldo da wallet é igual ao reconstruído pelo ledger e que as partidas fecham.

| Cenário do README §13 | Onde |
|---|---|
| Mesma aposta 50 vezes em paralelo | `test/concurrency/concurrency.test.ts` (3 processos) |
| Duas apostas de 80.00 com saldo 100.00 | idem |
| Wallets distintas em paralelo | idem |
| 3 ou mais instâncias | idem: 300 operações por HTTP e SQS numa wallet disputada |
| Worker morto depois do commit e antes do ack | `test/integration/messaging/consumer.test.ts` (processo real com `exit(137)`) |
| Dois publishers na mesma outbox | `test/integration/messaging/outbox.test.ts` (concorrentes, mais um processo morto entre publicar e marcar) |
| ROLLBACK ou REFUND antes da referência | `concurrency.test.ts` e `test/integration/wagering/pending-references.test.ts` |
| Reinício com consistência final | `test/concurrency/recovery.test.ts` (SIGKILL em todas as instâncias no meio da carga) |

Além disso: Postgres pausado (`docker compose pause`) devolve 503 e o reenvio aplica uma vez; ordem FIFO preservada em retry; schema testado com SQL puro (cada constraint e trigger); autorização entre providers; e um teste ponta a ponta com o Keycloak real através do nginx.

## 16. Interpretações do enunciado

- Reversão única por transação (ADR 0006): uma BET não pode receber REFUND e depois ROLLBACK, porque isso creditaria duas vezes.
- LOSS pode ter valor `0.00`; as demais operações exigem valor maior que zero.
- WIN pode referenciar a BET da rodada; sem referência, é aceito.
- OPENING gera `WalletOpened` e `WalletBalanceChanged`, mas não `WagerTransactionProcessed`, porque é interno.
- `FAILED` só existe para erro permanente de infraestrutura sobre uma operação com dados válidos. Responde 500 porque não é rejeição de negócio, mas é final: o replay devolve o mesmo `FAILED`, e um provider que reenvia 5xx automaticamente deve parar ao ver `failureCode`.
- `PENDING_REFERENCE` responde sem `balance`, porque a operação ainda não assentou.
- Erros de contrato não viram transação; ficam em `audit_log`. Pela fila, vão para a DLQ.
- `WALLET_NOT_FOUND` é 404 no HTTP. Na fila é retentado, porque a wallet pode ser criada logo depois.
- Reconciliação trava a wallet durante a leitura, para que saldo e ledger sejam lidos no mesmo instante.

## 17. Riscos e mitigações

| Risco | Comportamento | Prova |
|---|---|---|
| Postgres cai ou congela no meio da carga | timeouts no cliente: 503 com `Retry-After`, nada gravado pela metade, a mensagem SQS volta para a fila; o reenvio com a mesma key aplica uma vez | HTTP: `recovery.test.ts` (Postgres pausado); fila: `fifo-order.test.ts` e `failure-paths.test.ts` (falha transitória injetada) |
| Ids gigantes, corpo de MB, campos desconhecidos | ids limitados a `[A-Za-z0-9._:-]{1,128}`, corpo de no máximo 64 KB, schema estrito: 400 ou 413, nunca 500 | `api.test.ts` |
| Cursor do ledger adulterado | decodificado e validado: 400 `INVALID_CURSOR` | `queries.test.ts`, `api.test.ts` |
| Mesmo id externo com outra key | `UNIQUE (provider_id, external_transaction_id)`: 409 | `process-wager-transaction.test.ts` |
| Saldo que estouraria `bigint` | o banco recusa; a transação vira `FAILED` auditada e o saldo fica intacto | `process-wager-transaction.test.ts` |
| Conexão perdida no meio da transação | tratada como transitória, nunca como `FAILED` | `failure-paths.test.ts` |

Fora do alcance do desafio, com o que seria feito em produção:

- Postgres fora por muito tempo: depois de cerca de 5 minutos, as mensagens vão para a DLQ, que é recuperável com redrive. Em produção: failover (Patroni ou RDS Multi-AZ) e alarme sobre `sqs_dlq_total`.
- Vazão de FIFO por grupo: o SQS real limita a 300 mensagens/s por grupo (3000 com lotes). Uma wallet individual não chega perto disso, mas o tópico de eventos poderia, e nesse caso a saída seria SNS FIFO ou Kinesis com chave de partição.
- Keycloak sem alta disponibilidade: as chaves ficam em cache por 10 min. Em produção, cluster do Keycloak e rotação de chaves com sobreposição. O `jose` busca o JWKS de novo quando aparece um `kid` desconhecido.
- Região única: fora do escopo.
- Crescimento do ledger e da auditoria: sem particionamento. Em produção, particionamento por mês e retenção conforme a regulação.

## 18. Trade-offs e limitações

- Vazão por wallet: o lock pessimista serializa as operações de uma wallet. É a escolha certa para correção e para wallets de jogadores, mas uma wallet "da casa" atualizada a cada aposta seria um gargalo; por isso as contrapartidas não têm saldo corrente (ADR 0007).
- Outbox por agregado: um evento por agregado por rodada mantém a ordem, mas limita a vazão de uma wallet muito ativa. Com carga sustentada de cerca de 900 req/s, o atraso no fim da medição foi de cerca de 30 s, com drenagem em 16 s (`docs/load-test.md`).
- Shutdown: o long poll é abortado no SIGTERM para sair rápido. Uma mensagem já entregue a esse poll reaparece depois do timeout de visibilidade de 30 s.
- LocalStack 4.9 fixo: as imagens mais novas exigem token de licença. O MiniStack é a alternativa se a 4.9 sair do Docker Hub.
- TypeScript 6.0.3 para typecheck e lint: o `typescript-eslint` ainda não suporta o TypeScript 7. O Bun transpila sozinho, então isso não afeta a execução.
- Ausências: sem rate limiting na API, sem ferramenta de redrive da DLQ além da AWS CLI, sem tracing distribuído (OpenTelemetry é opcional no enunciado). As métricas são por instância; no compose, `/metrics` atrás do nginx responde por uma das três.
