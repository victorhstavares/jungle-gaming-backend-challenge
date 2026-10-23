# 0001. Dinheiro como bigint em centavos

Status: aceita

## Contexto

O enunciado proíbe `number`, `float` e `double` para dinheiro e exige valores trafegando como string decimal com escala fixa de 2 casas. O esqueleto de `Money` sugere um tipo `Decimal`.

## Decisão

`Money` guarda o valor como `bigint` de unidades mínimas (centavos) e a moeda como código ISO-4217. O banco usa colunas `bigint` (`*_minor`) e uma coluna de moeda separada.

- A entrada aceita somente `^(0|[1-9][0-9]{0,14})\.[0-9]{2}$`. `"25"`, `"25.5"`, `"0.005"`, `"1e3"`, `"-1.00"` e `" 1.00"` são recusados com `INVALID_MONEY`. Nada é arredondado.
- O limite de 15 dígitos inteiros mantém cada valor muito abaixo do teto de `bigint`; uma soma que estoure o teto é recusada pelo banco e a transação vira `FAILED` auditada.
- Toda moeda suportada usa escala 2. O modelo é multi-moeda; operações entre moedas diferentes lançam `CurrencyMismatchError`.
- O MikroORM mapeia `bigint` no modo `bigint` nativo do JavaScript, sem passar por `number`.

## Alternativas

- Biblioteca decimal (decimal.js, big.js): precisão arbitrária que o domínio não precisa, mais uma dependência e mais uma conversão na fronteira com o banco.
- `numeric(20,2)` no Postgres: exato, mas o driver devolve string e o código teria de converter em toda leitura; `bigint` em centavos é exato dos dois lados e mais barato de comparar e somar.

## Consequências

- Aritmética exata e barata, sem dependências.
- Mudar para uma moeda com outra escala (JPY com 0 casas, por exemplo) exigiria guardar a escala por moeda.
