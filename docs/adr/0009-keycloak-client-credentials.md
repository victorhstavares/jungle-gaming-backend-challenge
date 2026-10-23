# 0009. Keycloak com client credentials e validação local por JWKS

Status: aceita

## Contexto

Autenticação não pontua, mas, se existir, deve vir de um Identity Provider externo, sem tabela própria de usuários. Quem chama a API são sistemas (provedores de jogo e o back office), não pessoas.

## Decisão

- Keycloak 26 no compose, com o realm `jungle` importado de `keycloak/realm-jungle.json`. Os clients `provider-a` e `provider-b` têm o papel `provider` e o claim fixo `provider_id`; o client `backoffice` tem o papel `operator`. Todos têm a audience `wallet-service`.
- Fluxo OAuth2 client credentials.
- A API valida o JWT localmente com `jose`: assinatura RS256 contra o JWKS do Keycloak (com cache), `iss`, `aud` e `exp`. O Keycloak não é chamado a cada requisição.
- A porta `IdentityVerifier` isola a API do provedor de identidade.
- Autorização:
  - `provider` submete e consulta só transações do próprio `provider_id`. Um corpo com outro provider responde 403 `PROVIDER_MISMATCH`; uma transação de outro provider responde 404, para não revelar que ela existe.
  - `operator` cria wallets, lê o ledger e reconcilia.
  - Health e `/metrics` são abertos. Mensagens da fila são canal interno confiável, mas o `providerId` delas passa pelas mesmas validações de domínio.

## Consequências

- Uma queda curta do Keycloak não derruba a API, porque as chaves ficam em cache.
- Os testes de integração usam um emissor RS256 local com JWKS real, sem atalho de autenticação. Um teste ponta a ponta usa o Keycloak de verdade.
- Os segredos do realm são de desenvolvimento e estão versionados de propósito; em produção viriam de um cofre.
