# Distributed Wagering Processor

Serviço financeiro que processa transações de aposta (BET, WIN, LOSS, REFUND, ROLLBACK) recebidas por HTTP e por SQS, com idempotência persistente, ledger de partidas dobradas, inbox, outbox transacional e auditoria. Continua correto com mensagens duplicadas, fora de ordem e concorrentes, com várias instâncias e com quedas de processo ou de banco.

Stack: Bun 1.4 · TypeScript estrito · NestJS 12 (Fastify) · MikroORM 7 · PostgreSQL 17 · SQS via LocalStack 4.9 · Keycloak 26 · Docker Compose.

Para começar: [o que o sistema faz](docs/OVERVIEW.md), em uma página, e o [guia do avaliador](docs/EVALUATION.md), que aponta onde está cada item da avaliação e como ver tudo funcionando.

As decisões, os trade-offs e as limitações estão em [ARCHITECTURE.md](ARCHITECTURE.md). Cada decisão não óbvia tem um ADR em [docs/adr](docs/adr). O resumo dos testes está em [docs/TESTS.md](docs/TESTS.md) e o teste de carga em [docs/load-test.md](docs/load-test.md).

## Pré-requisitos

- Docker com Compose v2 (testado no Docker Desktop 29 com WSL2)
- Bun 1.4 (só para rodar os testes e os scripts fora do Docker)

## Subir tudo

```bash
docker compose up -d --build --wait
```

Isso sobe o Postgres, o LocalStack (com as filas criadas na inicialização), o Keycloak (com o realm `jungle` importado), roda as migrations e inicia três instâncias da aplicação atrás do nginx.

| Serviço | Endereço |
|---|---|
| API (nginx → 3 instâncias) | http://localhost:3000 |
| Keycloak | http://localhost:8080 (admin/admin) |
| PostgreSQL | localhost:5432 (wagering/wagering) |
| LocalStack (SQS) | http://localhost:4566 |

## Usar a API

Os tokens vêm do Keycloak por client credentials. Os clients de desenvolvimento são `backoffice` (papel `operator`), `provider-a` e `provider-b` (papel `provider`).

```bash
token() {
  curl -s http://localhost:8080/realms/jungle/protocol/openid-connect/token \
    -d grant_type=client_credentials -d client_id="$1" -d client_secret="$1-dev-secret" | jq -r .access_token
}
OPERATOR=$(token backoffice)
PROVIDER=$(token provider-a)
```

Criar uma wallet:

```bash
PLAYER=0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1
WALLET=$(curl -s localhost:3000/wallets -H "authorization: Bearer $OPERATOR" -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"1000.00\",\"currency\":\"BRL\"}}" | jq -r .id)
```

Apostar. Repita o mesmo comando para ver o replay (`idempotentReplay: true`, mesmo saldo):

```bash
curl -s localhost:3000/wagering/transactions -H "authorization: Bearer $PROVIDER" -H 'content-type: application/json' \
  -H 'idempotency-key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",
       \"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"
```

Consultas e reconciliação:

```bash
curl -s localhost:3000/wallets/$WALLET -H "authorization: Bearer $PROVIDER"
curl -s "localhost:3000/wallets/$WALLET/ledger?limit=50" -H "authorization: Bearer $OPERATOR"
curl -s localhost:3000/providers/provider-a/wagering/transactions/transaction-123 -H "authorization: Bearer $PROVIDER"
curl -s -X POST localhost:3000/wallets/$WALLET/reconciliation -H "authorization: Bearer $OPERATOR"
curl -s localhost:3000/health/ready
curl -s localhost:3000/metrics
```

Enviar pela fila:

```bash
docker compose exec localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "$WALLET" --message-deduplication-id msg-1 \
  --message-body "{\"messageId\":\"msg-1\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-10-24T12:00:00.000Z\",
    \"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-124\",\"idempotencyKey\":\"provider-a:transaction-124\",
    \"playerId\":\"$PLAYER\",\"walletId\":\"$WALLET\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"WIN\",
    \"money\":{\"amount\":\"40.00\",\"currency\":\"BRL\"}}}"
```

Os eventos publicados pela outbox ficam em `wallet-events.fifo`, e as mensagens recusadas ficam em `wager-transactions-dlq.fifo`, com os atributos `reason` e `code`.

## Comandos

| Comando | O que faz |
|---|---|
| `bun install` | instala as dependências |
| `bun run test` | testes de unidade, integração e concorrência (precisa de `docker compose up -d postgres localstack`) |
| `bun run test:unit` | só os de unidade, sem infraestrutura |
| `bun run test:integration` | integração contra Postgres e LocalStack reais |
| `bun run test:concurrency` | cenários do enunciado §13 com três processos reais, incluindo SIGKILL e Postgres pausado |
| `bun run test:e2e` | ponta a ponta com o Keycloak real (precisa da stack completa) |
| `bun run test:load -- --duration 60 --concurrency 50 --wallets 100` | teste de carga; grava `docs/load-test.md` |
| `bun run demo:chaos -- --duration 60 --wallets 20` | carga com SIGKILL em instâncias aleatórias e reconciliação de todas as wallets no fim |
| `bun run typecheck` · `bun run lint` | TypeScript estrito e ESLint com regras de tipo |
| `bun run migrate:up` · `bun run migrate:down` | aplica ou reverte migrations (lê `DATABASE_URL`) |
| `bun run dev` | API local com recarga (copie `.env.example` para `.env`; o Bun carrega o `.env` sozinho) |

Os testes criam um banco isolado por arquivo, a partir de um template migrado, e filas SQS próprias, então rodam em paralelo a uma stack que já esteja no ar.

## Estrutura

```
src/
  domain/          regras puras: Money, Wallet, WagerTransaction, ledger, inbox, outbox, eventos
  application/     casos de uso e portas
  infrastructure/  MikroORM e migrations, SQS, JWT, logger, métricas
  interface/       HTTP, consumidor SQS, workers
test/
  unit/  integration/  concurrency/  e2e/  support/
scripts/           teste de carga e demo de caos
docs/              ADRs e relatório de carga
keycloak/  localstack/  nginx/
```

## Configuração

Todas as variáveis estão em [`.env.example`](.env.example) e são validadas na inicialização; um valor inválido derruba o processo com o nome da variável. `APP_ROLES` escolhe quais papéis cada processo roda: `api`, `consumer`, `outbox` e `pending-reference` (padrão: todos).
