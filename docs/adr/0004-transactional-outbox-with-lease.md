# 0004. Outbox transacional com lease e ordem por agregado

Status: aceita

## Contexto

Nenhum evento pode sair antes do commit, nenhum evento confirmado pode se perder, e vários publishers podem rodar ao mesmo tempo. Se o processo morrer depois do commit e antes de publicar, outra instância assume.

## Decisão

Os eventos são gravados em `outbox_messages` na mesma transação da mudança financeira. Um worker os publica em `wallet-events.fifo`.

- Claim: `UPDATE ... SET locked_until = now() + 30s WHERE id IN (SELECT ... FOR UPDATE SKIP LOCKED)`, numa transação curta que comita antes de falar com o SQS. Nenhum lock de banco fica preso durante a chamada de rede.
- Ordem: só o evento não publicado mais antigo de cada agregado pode ser pego (`NOT EXISTS` de um anterior pendente, ordem `(occurred_at, id)`). Um evento que falhou bloqueia os seguintes do mesmo agregado até sair. Os timestamps são lidos sob o lock da wallet, então seguem a ordem dos commits enquanto os relógios das instâncias estiverem sincronizados; o `walletVersion` nos eventos de saldo deixa o consumidor ordenar mesmo com desvio de relógio.
- Publicação: `SendMessageBatch` de 10 em 10, `MessageGroupId` = agregado, `MessageDeduplicationId` = id do evento. O lote publicado é marcado num único `UPDATE`.
- Falha: backoff exponencial de 1 s até 5 min, `attempts` e `last_error` gravados, sem limite de tentativas. Uma mensagem nunca é descartada.
- Crash depois de publicar e antes de marcar: o lease expira, outro publisher publica de novo. O SQS descarta a repetição em até 5 min pelo id de deduplicação; depois disso, o consumidor descarta pelo `eventId`.

## Consequências

- At-least-once com deduplicação no consumidor, provado com um processo real morto entre a publicação e a marcação.
- A regra de um evento por agregado por rodada limita a vazão de uma wallet muito ativa. No teste de carga, o atraso no fim de 60 s de carga caiu de cerca de 170 s para 16 s com o envio em lote (ver `docs/load-test.md`).
