# 0006. Uma transação só pode ser revertida uma vez, por qualquer tipo

Status: aceita

## Contexto

A regra 4 da seção 7 diz que uma referência não pode ser revertida duas vezes "pelo mesmo tipo de operação". Lida ao pé da letra, uma BET poderia receber um REFUND e depois um ROLLBACK, e o jogador receberia o valor de volta duas vezes. Crédito duplicado é falha eliminatória.

## Decisão

Cada transação referenciada aceita no máximo uma reversão `PROCESSED`, seja REFUND ou ROLLBACK. O banco garante com o índice único parcial `wager_tx_single_reversal_idx` em `(reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND','ROLLBACK')`. A segunda tentativa é `REJECTED` com `REFERENCE_ALREADY_REVERSED`.

Um ROLLBACK de um REFUND continua permitido, porque o alvo é outra transação.

## Consequências

- Impossível creditar duas vezes a mesma aposta por reversões combinadas.
- Se a banca esperar a leitura literal (REFUND e ROLLBACK sobre a mesma BET), este é o ponto de divergência, escolhido de propósito.
