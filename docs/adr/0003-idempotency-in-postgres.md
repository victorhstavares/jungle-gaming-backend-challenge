# 0003. Idempotência persistida no Postgres

Status: aceita

## Contexto

A entrega é at-least-once e o enunciado proíbe cache em memória como garantia. A mesma key com payload diferente é conflito, não replay, e um replay devolve o resultado original, inclusive o saldo observado naquele momento.

## Decisão

A própria tabela `wager_transactions` é o registro de idempotência.

- `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)`. O escopo por provider impede que um provider ocupe a key de outro.
- `payload_hash` = SHA-256 em hex do JSON canônico (chaves ordenadas recursivamente, sem espaços, propriedades `undefined` omitidas) dos campos de negócio: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money` e `referenceExternalTransactionId`. O header e metadados de transporte não entram.
- A transação guarda `result_balance_minor`, o saldo visto quando ela assentou. O replay monta a resposta só a partir de campos persistidos; se a original estava pendente de referência e já assentou, o replay mostra o estado atual.
- Mesma key ou mesmo id externo com hash diferente responde 409 `IDEMPOTENCY_CONFLICT` e fica em `audit_log`.
- Se duas requisições com a mesma key em wallets diferentes passarem pela busca ao mesmo tempo, a segunda bate na UNIQUE; o caso de uso roda de novo uma vez e cai no replay ou no conflito.

## Consequências

- Funciona com qualquer número de instâncias, sobrevive a restart e não depende de TTL.
- O payload validado também é gravado em `audit_log`, então uma disputa sobre "o que o provider mandou" tem resposta no banco.
