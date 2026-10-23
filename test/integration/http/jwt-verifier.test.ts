import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { InvalidCredentialsError } from '../../../src/application/ports/identity';
import { JwtVerifier } from '../../../src/infrastructure/auth/jwt-verifier';
import { rejectionOf } from '../../support/db';
import { startTestIssuer, type TestIssuer } from '../../support/tokens';

let issuer: TestIssuer;
let verifier: JwtVerifier;

beforeAll(async () => {
  issuer = await startTestIssuer();
  verifier = new JwtVerifier({ jwksUrl: issuer.jwksUrl, issuer: issuer.issuer, audience: issuer.audience });
});

afterAll(async () => {
  await issuer.stop();
});

describe('JwtVerifier', () => {
  test('maps a provider token to a principal', async () => {
    const principal = await verifier.verify(await issuer.provider('provider-a'));
    expect(principal.clientId).toBe('provider-a');
    expect(principal.providerId).toBe('provider-a');
    expect([...principal.roles]).toEqual(['provider']);
  });

  test('maps an operator token without a provider id', async () => {
    const principal = await verifier.verify(await issuer.operator());
    expect([...principal.roles]).toEqual(['operator']);
    expect(principal.providerId).toBeUndefined();
  });

  test('ignores roles it does not know', async () => {
    const principal = await verifier.verify(await issuer.sign({ azp: 'x', realm_access: { roles: ['admin', 'operator'] } }));
    expect([...principal.roles]).toEqual(['operator']);
  });

  test.each([
    ['expired', () => issuer.sign({ azp: 'p' }, { expiresIn: '-1m' })],
    ['wrong audience', () => issuer.sign({ azp: 'p' }, { audience: 'another-api' })],
    ['wrong issuer', () => issuer.sign({ azp: 'p' }, { issuer: 'http://evil' })],
    ['garbage', () => Promise.resolve('not.a.jwt')],
    ['unsigned', () => Promise.resolve(`${btoa('{"alg":"none"}')}.${btoa('{"azp":"p"}')}.`)],
  ])('rejects a %s token', async (_label, make) => {
    expect(await rejectionOf(verifier.verify(await make()))).toBeInstanceOf(InvalidCredentialsError);
  });
});
