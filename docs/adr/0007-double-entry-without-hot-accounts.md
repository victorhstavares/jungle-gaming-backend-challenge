# 0007. Partidas dobradas sem conta quente

Status: aceita

## Contexto

Partidas dobradas são opcionais no enunciado. Uma implementação ingênua cria uma conta da casa com saldo corrente, e toda aposta de toda wallet passa a disputar a mesma linha: um lock global disfarçado, proibido pela restrição 6.

## Decisão

Toda movimentação gera dois lançamentos em `ledger_entries`:

- a perna `WALLET`, com `balance_before`, `balance_after` e `wallet_version`;
- a contrapartida `PROVIDER_CLEARING` (`providerId:moeda`) ou `SYSTEM_OPENING` (moeda), sem saldo corrente.

O banco exige no commit que débitos e créditos de cada transação somem zero (constraint trigger adiada). O saldo de uma conta de contrapartida, quando necessário, é uma soma sobre seus lançamentos, nunca uma linha atualizada a cada aposta.

## Consequências

- O ledger é auditável dos dois lados sem criar contenção entre wallets.
- Consultar o saldo da conta de um provider custa uma agregação; em produção isso viraria uma visão materializada atualizada fora do caminho da aposta.
