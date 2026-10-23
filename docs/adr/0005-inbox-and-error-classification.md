# 0005. Inbox no consumidor e classificação de erros da fila

Status: aceita

## Contexto

O consumidor SQS deve reaproveitar o caso de uso do HTTP, deduplicar por `(consumerName, messageId)`, dar ack só depois do commit e distinguir erros de negócio, transitórios e permanentes.

## Decisão

- `inbox_messages` tem PK `(consumer_name, message_id)` e é inserida na mesma transação da aposta. Se a transação faz rollback, a linha da inbox some junto e a redelivery processa de novo. Uma redelivery depois do commit encontra a linha e vira no-op.
- O hash guardado na inbox permite detectar um `messageId` reaproveitado com outro conteúdo: vai para a DLQ com `MESSAGE_ID_REUSED`.
- Classificação:
  - Negócio (transação gravada como `PROCESSED`, `REJECTED`, `PENDING_REFERENCE` ou `FAILED`): ack.
  - Transitório (Postgres fora, lock timeout, conexão perdida) e wallet inexistente (pode ser criada logo depois): a visibilidade volta com backoff de até 60 s.
  - Permanente (JSON ou contrato inválido, conflito de idempotência, `messageId` reaproveitado): envio explícito à DLQ com os atributos `reason` e `code`, delete e linha de auditoria.
- `maxReceiveCount` = 10. O consumidor estaciona a mensagem na DLQ por conta própria ao atingir o limite, com o motivo; a redrive policy da fila fica como rede de segurança.
- Mensagens do mesmo `MessageGroupId` são processadas em ordem. Se uma volta para retry, as seguintes do grupo são devolvidas sem processar.
- No SIGTERM, o consumidor para de buscar, termina as mensagens em andamento e devolve as não iniciadas com visibilidade 0.

## Consequências

- Com 10 entregas e backoff de até 60 s, uma queda de banco de alguns minutos não manda mensagens válidas para a DLQ.
- Uma mensagem pega por um long poll abortado no shutdown reaparece depois do timeout de visibilidade (30 s) e é processada nessa nova entrega.
