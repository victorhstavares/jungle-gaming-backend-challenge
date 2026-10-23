# Guia do avaliador

Onde encontrar cada item da avaliação (seção 14 do enunciado) e como ver tudo funcionando em poucos minutos.

## Ver funcionando

```bash
docker compose up -d --build --wait     # Postgres, LocalStack, Keycloak, migrations, 3 instâncias e nginx
bun install
bun run demo:chaos                      # carga HTTP e SQS, SIGKILL em instâncias, reconciliação de todas as wallets
bun run test:concurrency                # cenários do §13 contra 3 processos reais (cerca de 80 s)
```

O `demo:chaos` termina com uma tabela de wallets e a linha `All wallets consistent.`; sai com código 1 se alguma divergir. O [README](../README.md) tem os `curl` para testar a API à mão.

## Critérios eliminatórios

| Critério | Por que não se aplica | Onde ver |
|---|---|---|
| `number` para dinheiro | `bigint` em centavos do domínio ao banco | `src/domain/money/money.ts`, ADR 0001 |
| Saldo negativo por concorrência | lock da linha da wallet e `CHECK (balance_minor >= 0)` | `src/application/wagering/process-wager-transaction.ts`, `test/concurrency/concurrency.test.ts` (teste 2) |
| Débito ou crédito duplicado | idempotência por UNIQUE no banco, inbox na fila, reversão única por índice parcial | ADRs 0003, 0005 e 0006, `concurrency.test.ts` (teste 1) |
| Idempotência só em memória | tudo em `wager_transactions` e `inbox_messages` | `src/infrastructure/persistence/migrations/Migration20261023000001_core.ts` |
| Correto só com 1 instância | todos os testes de concorrência usam 3 processos | `test/concurrency/harness.ts` |
| Evento publicado antes do commit | outbox gravada na mesma transação, publicada depois | ADR 0004, `src/application/outbox/publish-outbox-batch.ts` |
| Sem ledger auditável | partidas dobradas imutáveis, histórico de status por trigger, `audit_log` | ADRs 0007, 0008 e 0010 |
| Postgres ou SQS mockados | nenhum mock; cada arquivo de teste usa banco e filas próprios | `test/support/db.ts`, `test/support/sqs.ts` |

## Tabela de pontos

| Área | Onde olhar | Prova |
|---|---|---|
| Correção financeira (20) | `src/domain/`, `src/application/wallets/reconcile-wallet.ts`, ADRs 0001 e 0006 | `test/unit/domain/*`, `wallets/queries.test.ts` |
| Concorrência (20) | lock e ordem de lock em `process-wager-transaction.ts`, ADR 0002 | `test/concurrency/*` |
| Idempotência (15) | `wager-command.ts` (hash canônico), ADR 0003 | `process-wager-transaction.test.ts`, `concurrency.test.ts` |
| Mensageria e falhas (15) | `src/interface/messaging/`, `src/application/outbox/`, `src/application/pending/`, ADRs 0004 e 0005 | `test/integration/messaging/*`, `lifecycle.test.ts`, `recovery.test.ts` |
| Modelagem e arquitetura (10) | camadas em `src/`, `ARCHITECTURE.md` §1 a §3 | o domínio é testado sem banco: `test/unit/domain/*` |
| Testes (10) | [TESTS.md](TESTS.md) | 259 testes, nenhum mock de infraestrutura |
| Observabilidade (5) | `src/infrastructure/observability/`, `ARCHITECTURE.md` §14 | `http/metrics.test.ts`, `GET /metrics`, `/health/ready` |
| Documentação (5) | `README.md`, `ARCHITECTURE.md`, `docs/adr/`, [OVERVIEW.md](OVERVIEW.md) | |

## Diferenciais entregues

- Autenticação com Keycloak (client credentials) e autorização por provider: ADR 0009 e `test/e2e/keycloak.e2e.test.ts`.
- Ledger de partidas dobradas sem conta quente: ADR 0007.
- Teste de carga com análise: [load-test.md](load-test.md). Cerca de 900 req/s com p99 de cerca de 127 ms; o gargalo encontrado na outbox foi medido, corrigido e medido de novo.
- Demo de caos: `scripts/chaos.ts`.

## Decisões que valem discussão

- Uma transação só pode ser revertida uma vez, por qualquer tipo, mais rígido que a leitura literal da regra 4 (ADR 0006).
- Lock pessimista em vez de otimista: a fila de espera fica no Postgres, e a vazão de uma única wallet fica limitada a uma transação por vez (ADR 0002).
- Ordem dos eventos por agregado em troca de vazão da outbox numa wallet muito ativa (ADR 0004, `load-test.md`).
- O que ficou fora e por quê: `ARCHITECTURE.md` §17 e §18.
