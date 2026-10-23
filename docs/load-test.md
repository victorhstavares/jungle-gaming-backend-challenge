# Teste de carga

Gerado por `bun run test:load -- --duration 60 --concurrency 50 --wallets 100` em 2026-10-23T22:20:22.853Z.

## Ambiente

| Item | Valor |
|---|---|
| CPU | AMD Ryzen 7 5700X3D 8-Core Processor (16 threads) |
| Memória | 15.6 GiB |
| Sistema | Windows + WSL2, Docker Desktop 29.8.2 |
| Bun | 1.4.4 |
| Topologia | nginx → 3 instâncias (todos os papéis) → Postgres 17 e LocalStack 4.9, tudo no mesmo host |

## Metodologia

- 100 wallets com saldo inicial de 10000.00 BRL, criadas antes da medição.
- 50 clientes concorrentes em laço fechado por 60s, cada um escolhendo uma wallet ao acaso.
- Mistura: 10% replays de uma requisição anterior (mesma key e corpo); do restante, 60% BET, 25% WIN, 10% LOSS e 5% REFUND de uma BET já processada.
- Token client credentials real do Keycloak; toda requisição passa pelo nginx.
- Ao final, reconciliação de todas as wallets pela API.

## Resultados

| Métrica | Valor |
|---|---|
| Requisições | 54428 |
| Throughput | 906.4 req/s |
| p50 | 50.7 ms |
| p95 | 93.2 ms |
| p99 | 126.6 ms |
| Taxa de erro (5xx ou falha de rede) | 0.0% (0) |
| Replays respondidos sem erro | 5407 de 5407 |
| Wallets consistentes na reconciliação | 100 de 100 |
| Timeouts de lock da wallet (uma instância) | 0 |
| Espera de lock acumulada (uma instância) | 188.05514351399916 s em 18060 locks |
| Outbox lag no fim (uma instância) | 32.504 s |

### Respostas por status

| Status | Quantidade |
|---|---|
| 201 | 54428 |

### Códigos de rejeição ou erro

| Código | Quantidade |
|---|---|
| (nenhum) | 0 |

## Análise

### Correção sob carga

Nenhuma resposta 5xx, todos os replays devolveram a resposta original e as 100 wallets terminaram com o saldo igual ao reconstruído pelo ledger. Não houve rejeição por saldo porque cada wallet começou com 10000.00 e as apostas eram de 1.00; os cenários de disputa de saldo ficam nos testes de concorrência.

### Latência

O p50 de cerca de 50 ms é quase todo espera pelo lock da wallet: 100 wallets para 50 clientes concorrentes significa que, a cada instante, várias requisições disputam a mesma linha. A espera média por lock ficou em torno de 10 ms por operação numa instância. Com mais wallets e a mesma concorrência, a disputa cai; com uma única wallet muito disputada, a vazão dela fica limitada a uma transação por vez, que é o preço do lock pessimista por wallet (ver ADR 0002).

### Outbox: o gargalo encontrado

A primeira medição mostrou o publicador drenando cerca de 440 eventos/s somando as três instâncias, contra cerca de 1700 eventos/s gerados (duas linhas de outbox por aposta). O backlog chegou a 67 mil eventos. Marcar o lote num único `UPDATE` não mudou o quadro (82 mil na rodada seguinte, cerca de 170 s para zerar), então a consulta de claim foi medida com `EXPLAIN ANALYZE` (124 ms, aceitável) e o envio ao broker virou o suspeito. Medindo o LocalStack isoladamente: 158 envios/s com `SendMessage` e 1521 mensagens/s com `SendMessageBatch`. Com o envio em lotes de 10, o resultado na mesma carga: backlog de cerca de 20 mil no fim e drenagem completa em 16 s. Nenhum evento se perde em nenhum dos casos; o que muda é o atraso.

### O que ainda limita

O claim entrega no máximo um evento pendente por agregado por rodada, para garantir a ordem por wallet. Uma wallet que gera eventos mais rápido do que uma rodada por evento acumula atraso. Em produção, com SQS real (limite de 300 envios/s por grupo FIFO, ou 3000 com lotes), as opções são: particionar o publicador por hash do agregado para dispensar o `NOT EXISTS`, ou publicar em SNS/Kinesis com chave de partição.

### Limites desta medição

Tudo roda na mesma máquina via WSL2 (Postgres, LocalStack, Keycloak, três instâncias e o gerador de carga), então os números servem para comparar versões, não como capacidade de produção. As métricas de lock e lag vêm de uma instância só, a que o nginx escolheu para responder `/metrics`.
