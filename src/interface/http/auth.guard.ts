import { Inject, Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { InvalidCredentialsError, type IdentityVerifier, type Role } from '../../application/ports/identity';
import type { Logger, Metrics } from '../../application/ports/observability';
import { TOKENS } from '../../composition/tokens';
import { ForbiddenError, UnauthenticatedError } from './request-context';

const PUBLIC_KEY = 'auth:public';
const ROLES_KEY = 'auth:roles';

export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC_KEY, true);
export const Roles = (...roles: Role[]): MethodDecorator & ClassDecorator => SetMetadata(ROLES_KEY, roles);

/** Every route is authenticated unless marked @Public(); @Roles() narrows who may call it. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(TOKENS.identity) private readonly identity: IdentityVerifier,
    @Inject(TOKENS.logger) private readonly logger: Logger,
    @Inject(TOKENS.metrics) private readonly metrics: Metrics,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean | undefined>(PUBLIC_KEY, targets) === true) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers.authorization;
    const token = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
    if (token === undefined || token.length === 0) {
      this.reject('missing_token', request);
      throw new UnauthenticatedError('Bearer token required');
    }

    try {
      request.principal = await this.identity.verify(token);
    } catch (error) {
      if (error instanceof InvalidCredentialsError) {
        this.reject('invalid_token', request);
        throw new UnauthenticatedError('Invalid or expired token');
      }
      throw error;
    }

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, targets) ?? [];
    if (required.length > 0 && !required.some((role) => request.principal?.roles.has(role) === true)) {
      this.reject('missing_role', request);
      throw new ForbiddenError('FORBIDDEN', 'Token lacks the role required by this route');
    }
    return true;
  }

  private reject(reason: string, request: FastifyRequest): void {
    this.metrics.increment('auth_failures_total', { reason });
    this.logger.warn(
      { correlationId: request.correlationId, reason, method: request.method, route: request.routeOptions.url },
      'request rejected by authentication',
    );
  }
}
