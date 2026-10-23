/**
 * Runs against the full compose stack (`docker compose up -d --wait`): Keycloak issues real client-credentials
 * tokens and every request goes through nginx to one of the three instances.
 */
import { describe, expect, test } from 'bun:test';

const API = process.env.E2E_API_URL ?? 'http://localhost:3000';
const TOKEN_URL = process.env.E2E_TOKEN_URL ?? 'http://localhost:8080/realms/jungle/protocol/openid-connect/token';

async function token(clientId: string, secret: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function call(path: string, accessToken: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${API}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('full stack with Keycloak', () => {
  test('operators open wallets, providers bet for themselves only, and the ledger reconciles', async () => {
    const backoffice = await token('backoffice', 'backoffice-dev-secret');
    const providerA = await token('provider-a', 'provider-a-dev-secret');

    const playerId = crypto.randomUUID();
    const wallet = await call('/wallets', backoffice, { playerId, initialBalance: { amount: '1000.00', currency: 'BRL' } });
    expect(wallet.status).toBe(201);
    const walletId = String(wallet.body.id);

    const externalTransactionId = `e2e-${crypto.randomUUID()}`;
    const bet = {
      providerId: 'provider-a',
      externalTransactionId,
      playerId,
      walletId,
      roundId: 'round-987',
      gameId: 'fortune-chimp',
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
    };
    const placed = await call('/wagering/transactions', providerA, bet, { 'idempotency-key': `provider-a:${externalTransactionId}` });
    expect(placed.status).toBe(201);
    expect(placed.body).toMatchObject({ status: 'PROCESSED', balance: { amount: '975.00', currency: 'BRL' }, idempotentReplay: false });

    const impersonation = await call('/wagering/transactions', providerA, { ...bet, providerId: 'provider-b' }, { 'idempotency-key': 'x' });
    expect(impersonation.status).toBe(403);
    expect(impersonation.body.code).toBe('PROVIDER_MISMATCH');

    expect((await call('/wallets', providerA, { playerId: crypto.randomUUID(), initialBalance: { amount: '1.00', currency: 'BRL' } })).status).toBe(403);

    const reconciliation = await call(`/wallets/${walletId}/reconciliation`, backoffice, {});
    expect(reconciliation.body).toMatchObject({ consistent: true, storedBalance: { amount: '975.00', currency: 'BRL' } });
  });
});
