import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
  InvalidCredentialsError,
  type IdentityVerifier,
  type Principal,
  type Role,
} from '../../application/ports/identity';

export interface JwtVerifierOptions {
  jwksUrl: string;
  issuer: string;
  audience: string;
}

const KNOWN_ROLES: ReadonlySet<string> = new Set<Role>(['provider', 'operator']);

const isRole = (value: unknown): value is Role => typeof value === 'string' && KNOWN_ROLES.has(value);

function rolesOf(payload: JWTPayload): Set<Role> {
  const realmAccess: unknown = payload.realm_access;
  const roles: unknown =
    typeof realmAccess === 'object' && realmAccess !== null ? Reflect.get(realmAccess, 'roles') : undefined;
  return new Set(Array.isArray(roles) ? roles.filter(isRole) : []);
}

/**
 * Validates OIDC access tokens locally against the issuer's published keys. Keys are cached by jose, so the
 * identity provider is not called per request and a brief outage of it does not take the API down.
 */
export class JwtVerifier implements IdentityVerifier {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(private readonly options: JwtVerifierOptions) {
    this.jwks = createRemoteJWKSet(new URL(options.jwksUrl), { cacheMaxAge: 10 * 60_000, cooldownDuration: 30_000 });
  }

  async verify(bearerToken: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(bearerToken, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: ['RS256'],
        clockTolerance: 5,
      }));
    } catch (error) {
      throw new InvalidCredentialsError('Invalid access token', { cause: error });
    }

    const clientId = typeof payload.azp === 'string' ? payload.azp : payload.sub;
    if (clientId === undefined || clientId.length === 0) {
      throw new InvalidCredentialsError('Access token has no client identity');
    }
    const providerId: unknown = payload.provider_id;
    return {
      clientId,
      roles: rolesOf(payload),
      ...(typeof providerId === 'string' && providerId.length > 0 ? { providerId } : {}),
    };
  }
}
