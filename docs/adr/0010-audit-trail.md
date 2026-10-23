# 0010. Trilha de auditoria completa

Status: aceita

## Contexto

Num sistema de apostas, toda tentativa precisa deixar rastro, inclusive as recusadas antes de virar transação, para que se possa explicar depois o que aconteceu e por quê.

## Decisão

Três tabelas só de inserção (triggers bloqueiam `UPDATE`, `DELETE` e `TRUNCATE`):

- `audit_log`: uma linha por tentativa que muda estado, com origem (`HTTP`, `SQS`, `WORKER`), ator (client id do token ou consumidor), operação, resultado (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, `REPLAY`, `IDEMPOTENCY_CONFLICT`, `CONTRACT_ERROR`, `DLQ`, `FAILED`, `NOT_FOUND`, `DUPLICATE_MESSAGE`), código, correlation id, message id, idempotency key, hash e o payload validado. No caminho feliz vai na mesma transação; quando a transação principal faz rollback, vai numa transação curta separada.
- `wager_transaction_status_history`: gravada pelo próprio banco, por trigger, a cada mudança de status ou de tentativa, com o correlation id da transação (`SET LOCAL app.correlation_id`).
- `reconciliation_runs`: cada reconciliação com saldo armazenado, calculado, diferença e quem pediu.

Ficam fora do banco, só em log e métrica: requisições sem autenticação e falhas transitórias, que serão reenviadas e auditadas na tentativa seguinte.

## Consequências

- O payload financeiro fica no banco, onde o acesso é controlado, e nunca nos logs.
- As tabelas crescem sem limite; em produção precisariam de particionamento por tempo e de uma política de retenção.
