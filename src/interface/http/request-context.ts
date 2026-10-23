import type { FastifyRequest } from 'fastify';
import type { Principal } from '../../application/ports/identity';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
    principal?: Principal;
    startedAt: number;
  }
}

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
}

export class ForbiddenError extends Error {
  constructor(
    readonly code: 'FORBIDDEN' | 'PROVIDER_MISMATCH',
    message: string,
  ) {
    super(message);
  }
}

export function principalOf(request: FastifyRequest): Principal {
  if (request.principal === undefined) throw new UnauthenticatedError('Authentication required');
  return request.principal;
}

/** Operators act for every provider; a provider may only act for the provider id in its token. */
export function assertActsFor(principal: Principal, providerId: string): void {
  if (principal.roles.has('operator')) return;
  if (principal.providerId !== providerId) {
    throw new ForbiddenError('PROVIDER_MISMATCH', 'Token is not allowed to act for this provider');
  }
}

export function canSee(principal: Principal, providerId: string): boolean {
  return principal.roles.has('operator') || principal.providerId === providerId;
}
