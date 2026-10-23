# Testes

258 testes no total, todos contra Postgres e LocalStack reais. Nenhum mock de banco ou de fila.

| Grupo | Testes | Comando | Tempo |
|---|---|---|---|
| Unidade | 126 | `bun run test:unit` | < 1 s |
| Integração | 124 | `bun run test:integration` | ~ 70 s |
| Concorrência (3 processos reais) | 7 | `bun run test:concurrency` | ~ 80 s |
| Ponta a ponta (Keycloak + nginx) | 1 | `bun run test:e2e` | < 1 s |

`bun run test` roda unidade, integração e concorrência (257 testes, cerca de 150 s). Precisa de `docker compose up -d postgres localstack`; o e2e precisa da stack completa.

Todo teste que toca dinheiro termina conferindo a mesma invariante: saldo da wallet igual ao saldo reconstruído pelo ledger, e débitos iguais a créditos em cada transação.

## Unidade (`test/unit`)

| Arquivo | Testes | O que prova |
|---|---|---|
| `domain/money.test.ts` | 26 | aceita só string com 2 casas, nunca arredonda, aritmética exata em centavos, recusa misturar moedas |
| `domain/wager-rules.test.ts` | 23 | cada regra de BET, WIN, LOSS, REFUND e ROLLBACK, com o código de falha certo |
| `infrastructure/pg-errors.test.ts` | 20 | cada erro do Postgres vira retry, conflito ou erro permanente |
| `domain/wager-transaction.test.ts` | 12 | máquina de estados: status terminal não muda, REFUND e ROLLBACK exigem referência |
| `application/wager-command.test.ts` | 11 | validação da entrada e hash canônico do payload |
| `domain/wallet.test.ts` | 7 | débito, crédito, saldo insuficiente, versão só sobe quando o saldo muda |
| `domain/events.test.ts` | 6 | envelope versionado dos eventos, com dinheiro como string |
| `domain/canonical-json.test.ts` | 5 | JSON canônico independe da ordem das chaves |
| `domain/ledger-entry.test.ts` | 4 | lançamento só existe se a conta fecha |
| `domain/messaging.test.ts` | 4 | inbox, outbox e backoff |
| `infrastructure/observability.test.ts` | 4 | logs JSON sem segredos, correlation id e métricas |
| `config/config.test.ts` | 4 | configuração inválida derruba o processo com o nome da variável |

## Integração (`test/integration`)

| Arquivo | Testes | O que prova |
|---|---|---|
| `http/api.test.ts` | 24 | todas as rotas, um status por situação, autorização entre providers, auditoria de erros de contrato |
| `schema/triggers.test.ts` | 19 | ledger imutável, saldo e ledger andando juntos, histórico de status gravado pelo banco |
| `schema/constraints.test.ts` | 15 | cada CHECK e UNIQUE recusa a linha errada; migrations sobem, descem e sobem de novo |
| `wallets/queries.test.ts` | 13 | paginação do ledger, cursor adulterado, reconciliação que acusa sem corrigir |
| `wagering/process-wager-transaction.test.ts` | 11 | caso de uso completo: replay, conflito, referência fora de ordem, overflow vira `FAILED` |
| `http/jwt-verifier.test.ts` | 9 | tokens expirados, de outro emissor, sem assinatura; chaves indisponíveis viram 503 |
| `messaging/consumer.test.ts` | 8 | ack só depois do commit, redelivery aplicada uma vez, DLQ com motivo, processo morto antes do ack |
| `persistence/repositories.test.ts` | 7 | lock da wallet serializa, inbox recebe uma vez, claims concorrentes não se cruzam |
| `wagering/failure-paths.test.ts` | 4 | conexão perdida nunca vira `FAILED`; conflito nunca vira replay |
| `wallets/open-wallet.test.ts` | 4 | abertura com transação OPENING, partidas dobradas e auditoria; wallet duplicada é conflito |
| `messaging/outbox.test.ts` | 4 | dois publicadores sem duplicar, retry com backoff, ordem por agregado, publicador morto substituído |
| `wagering/pending-references.test.ts` | 3 | reversão pendente assenta quando a aposta chega; desiste depois de 10 tentativas |
| `messaging/fifo-order.test.ts` | 1 | mensagem em retry segura as seguintes do mesmo grupo |
| `http/metrics.test.ts` | 1 | as métricas do enunciado mudam com tráfego real |
| `lifecycle.test.ts` | 1 | processo real consome, publica e sai com código 0 no SIGTERM sem perder mensagem |

## Concorrência (`test/concurrency`, 3 processos reais)

| Arquivo | Testes | O que prova |
|---|---|---|
| `concurrency.test.ts` | 5 | mesma aposta 50 vezes debita uma; duas de 80 com saldo 100 deixam 20; wallets em paralelo; 300 operações por HTTP e SQS numa wallet disputada; reversões antes da aposta |
| `recovery.test.ts` | 2 | SIGKILL em todas as instâncias no meio da carga termina consistente; Postgres pausado responde 503 e o reenvio aplica uma vez |

## Ponta a ponta (`test/e2e`)

| Arquivo | Testes | O que prova |
|---|---|---|
| `keycloak.e2e.test.ts` | 1 | tokens reais do Keycloak através do nginx: operator abre wallet, provider aposta, provider não age por outro, reconciliação consistente |
