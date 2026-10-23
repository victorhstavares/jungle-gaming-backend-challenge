# 0002. Lock pessimista na linha da wallet

Status: aceita

## Contexto

A unidade de concorrência é a wallet. Várias instâncias podem receber, ao mesmo tempo, operações da mesma wallet por HTTP e por SQS. O enunciado aceita lock pessimista, lock otimista com retry limitado ou update condicional, desde que justificado.

## Decisão

Toda operação que pode mudar saldo roda numa transação `READ COMMITTED` que começa com `SELECT ... FROM wallets WHERE id = ? FOR UPDATE` (via `LockMode.PESSIMISTIC_WRITE` do MikroORM). A busca de idempotência, a resolução da referência e a decisão acontecem depois do lock.

- Ordem de lock fixa: wallet, depois transação. O worker de referências pendentes segue a mesma ordem.
- `lock_timeout` de 5 s e `statement_timeout` de 10 s por transação (`SET LOCAL`), e timeouts no cliente (`connectionTimeoutMillis` 3 s, `query_timeout` 12 s) para que um banco congelado vire 503 em vez de requisição pendurada.
- `version` existe e incrementa a cada mudança de saldo, mas como trilha de auditoria e amarração com o ledger, não como mecanismo de concorrência.

## Alternativas

- Lock otimista com retry: numa wallet disputada (a aposta e o resultado de uma rodada chegam juntos), os retries viram uma tempestade de conflitos e a latência de cauda explode. Com o lock, a fila de espera fica dentro do Postgres e é justa.
- Update condicional (`UPDATE ... SET balance = balance - x WHERE balance >= x`): resolve o saldo, mas a idempotência, a referência e o ledger precisam ler estado consistente antes de decidir; o lock dá esse estado de graça.
- Lock distribuído (Redis): proibido como lock global e desnecessário, o Postgres já é a fonte da verdade.

## Consequências

- Operações da mesma wallet são serializadas; wallets diferentes rodam em paralelo (provado no teste de 20 wallets × 10 apostas e no teste de carga).
- A vazão de uma única wallet fica limitada a uma transação por vez. No teste de carga, a espera média por lock ficou em torno de 10 ms com 50 clientes sobre 100 wallets.
- Requisições idênticas concorrentes (o mesmo BET 50 vezes) fazem fila no lock: a primeira grava, as outras 49 encontram o registro e respondem replay.
