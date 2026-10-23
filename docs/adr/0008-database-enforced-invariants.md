# 0008. Invariantes garantidas no schema

Status: aceita

## Contexto

A restrição 9 exige unicidade, imutabilidade e não-negatividade no schema, não só no código. O desenho do schema faz parte da avaliação.

## Decisão

Cada invariante tem uma barreira no banco:

| Invariante | Barreira |
|---|---|
| Saldo nunca negativo | `CHECK (balance_minor >= 0)` em `wallets` e nas pernas `WALLET` do ledger |
| Uma wallet por jogador e moeda | `UNIQUE (player_id, currency)` |
| Idempotência | `UNIQUE (provider_id, idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` |
| Reversão única | índice único parcial `wager_tx_single_reversal_idx` |
| Lançamento bate | `CHECK` de `balance_after = balance_before ± amount` |
| Ledger imutável | triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE` |
| Saldo e ledger em lockstep | constraint trigger adiada: todo saldo de wallet tem lançamento `WALLET` na mesma versão com o mesmo `balance_after`; cada lançamento continua o saldo do anterior |
| Partida dobrada fecha | constraint trigger adiada: débitos = créditos por transação |
| Versão acompanha o saldo | trigger: saldo muda ⇔ versão sobe exatamente 1 |
| Status terminal não muda | trigger bloqueia alteração de transação `PROCESSED`, `REJECTED` ou `FAILED` e de campos de negócio |
| Histórico de status | trigger grava toda transição em `wager_transaction_status_history` |

Toda violação de trigger usa `SQLSTATE P0001` com mensagem prefixada `integrity:`. A aplicação traduz esses erros em `IntegrityViolationError`, que vira uma transação `FAILED` auditada, nunca um retry.

## Consequências

- Um bug na aplicação ou um `UPDATE` manual não consegue criar saldo sem lançamento, apagar histórico ou duplicar reversão. Os testes de schema provam cada regra inserindo linhas com SQL puro.
- As constraint triggers custam uma consulta por linha no commit; medido no teste de carga, o custo fica dentro do p99 de cerca de 127 ms.
- Corrigir dado em produção exige uma migration explícita e revisada, o que é o comportamento desejado para um ledger.
