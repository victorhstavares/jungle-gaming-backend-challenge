import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from 'jose';

export interface TestIssuer {
  jwksUrl: string;
  issuer: string;
  audience: string;
  sign: (claims: JWTPayload, options?: { expiresIn?: string; audience?: string; issuer?: string }) => Promise<string>;
  provider: (providerId: string) => Promise<string>;
  operator: () => Promise<string>;
  stop: () => Promise<void>;
}

/** A real RS256 issuer with a JWKS endpoint, so tests go through the same signature checks as production. */
export async function startTestIssuer(): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ keys: [jwk] }) });
  const issuer = `http://localhost:${String(server.port)}/realms/test`;
  const audience = 'wallet-service';

  const sign: TestIssuer['sign'] = (claims, options = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer(options.issuer ?? issuer)
      .setAudience(options.audience ?? audience)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m')
      .sign(privateKey);

  return {
    jwksUrl: `http://localhost:${String(server.port)}/certs`,
    issuer,
    audience,
    sign,
    provider: (providerId) =>
      sign({ azp: providerId, provider_id: providerId, realm_access: { roles: ['provider'] } }),
    operator: () => sign({ azp: 'backoffice', realm_access: { roles: ['operator'] } }),
    stop: async () => {
      await server.stop(true);
    },
  };
}
