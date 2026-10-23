export type Role = 'provider' | 'operator';

/** Who is calling, as asserted by the identity provider. Providers carry the provider id they may act for. */
export interface Principal {
  clientId: string;
  roles: ReadonlySet<Role>;
  providerId?: string;
}

/** Extension point for authentication: the API depends only on this port, so the identity provider can change. */
export interface IdentityVerifier {
  verify(bearerToken: string): Promise<Principal>;
}

export class InvalidCredentialsError extends Error {
  readonly code = 'UNAUTHENTICATED';
}
