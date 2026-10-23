# O que o sistema faz

É a carteira de um cassino online. Provedores de jogo avisam o que aconteceu em cada rodada (aposta, ganho, perda, estorno, cancelamento), e o sistema move o saldo do jogador, registra cada movimento num livro contábil que não pode ser alterado e avisa outros sistemas por eventos.

## Quem usa

- Provedores de jogo (`provider-a`, `provider-b`) enviam as operações por HTTP ou por uma fila SQS. Cada provider só enxerga e envia as próprias operações.
- O back office (`backoffice`) abre wallets, consulta o livro contábil e pede reconciliação.
- Outros sistemas consomem os eventos publicados em `wallet-events.fifo`.

O login é feito no Keycloak; a API só aceita tokens emitidos por ele.

## O que acontece com uma aposta

1. O provider manda a operação com uma chave de idempotência.
2. O sistema trava a wallet daquele jogador. Outras wallets seguem em paralelo.
3. Se a mesma operação já foi recebida, devolve a resposta original, com o saldo daquela hora. Se a chave já foi usada para outra coisa, recusa como conflito.
4. Aplica a regra da operação:

| Operação | Efeito |
|---|---|
| BET | debita, se houver saldo |
| WIN | credita |
| LOSS | registra o resultado, sem mexer no saldo |
| REFUND | devolve uma aposta, uma única vez |
| ROLLBACK | desfaz uma aposta, ganho ou estorno, uma única vez |

5. Grava tudo de uma vez: a operação, o novo saldo, os dois lados do lançamento contábil, os eventos a publicar e a linha de auditoria. Ou entra tudo, ou nada.
6. Responde ao provider (ou confirma a mensagem da fila) só depois disso.
7. Em seguida, um publicador envia os eventos.

## Quando algo dá errado

| Situação | O que acontece |
|---|---|
| A mesma operação chega várias vezes | é aplicada uma vez; as outras recebem a resposta original |
| Duas apostas disputam o mesmo saldo | a segunda espera a primeira; quem não couber no saldo é recusada |
| Um estorno chega antes da aposta | fica aguardando e é aplicado quando a aposta chega; desiste depois de cerca de 13 minutos |
| Uma instância morre no meio do caminho | o que não foi confirmado é refeito por outra instância, sem duplicar |
| O banco fica fora do ar | a API responde "tente de novo" (503); a fila segura as mensagens por alguns minutos e, se o banco não voltar, as move para a fila de mensagens mortas, de onde podem ser reenviadas |
| Uma mensagem da fila é inválida | vai para uma fila de mensagens mortas, com o motivo registrado |
| O saldo e o livro contábil divergirem | a reconciliação acusa e registra; nunca corrige sozinha |

## O que nunca acontece

- Saldo negativo.
- Débito ou crédito em dobro.
- Movimento de saldo sem lançamento contábil.
- Evento publicado de algo que não foi gravado.
- Lançamento contábil alterado ou apagado.

Essas garantias estão no próprio banco de dados, além do código: mesmo um comando SQL escrito à mão é recusado se quebrar alguma delas. O que o banco não tem como impedir sozinho, como um lançamento avulso inserido à mão sem mexer no saldo, a reconciliação acusa.

Para os detalhes técnicos, veja [ARCHITECTURE.md](../ARCHITECTURE.md). Para os testes que provam cada ponto, veja [TESTS.md](TESTS.md).
