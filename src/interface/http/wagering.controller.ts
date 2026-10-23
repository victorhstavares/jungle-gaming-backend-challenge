import { Body, Controller, Get, Headers, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuditRecorder } from '../../application/audit/audit-recorder';
import { ContractError, TransactionNotFoundError } from '../../application/errors';
import type { Clock } from '../../application/ports/clock';
import type { ProcessWagerTransaction } from '../../application/wagering/process-wager-transaction';
import { parseWagerCommand } from '../../application/wagering/wager-command';
import type { TransactionView, WagerQueries } from '../../application/wagering/wager-queries';
import type { AppConfig } from '../../config/config';
import { TOKENS } from '../../composition/tokens';
import { Roles } from './auth.guard';
import { ForbiddenError, assertActsFor, canSee, principalOf } from './request-context';
import { identifierParam, singleHeader, uuidParam } from './schemas';
import { statusForWager } from './status-mapping';

interface SubmitResponse {
  transactionId?: string;
  status?: string;
  balance?: { amount: string; currency: string };
  failureCode?: string;
  idempotentReplay: boolean;
}

@Controller()
export class WageringController {
  constructor(
    @Inject(TOKENS.processWager) private readonly processWager: ProcessWagerTransaction,
    @Inject(TOKENS.wagerQueries) private readonly queries: WagerQueries,
    @Inject(TOKENS.config) private readonly config: AppConfig,
    @Inject(TOKENS.audit) private readonly audit: AuditRecorder,
    @Inject(TOKENS.clock) private readonly clock: Clock,
  ) {}

  @Post('wagering/transactions')
  @Roles('provider')
  async submit(
    @Body() body: unknown,
    @Headers('idempotency-key') idempotencyKey: string | string[] | undefined,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SubmitResponse> {
    const principal = principalOf(request);
    let command: ReturnType<typeof parseWagerCommand>;
    try {
      command = parseWagerCommand(
        body,
        singleHeader(idempotencyKey, 'Idempotency-Key'),
        this.config.supportedCurrencies,
      );
      assertActsFor(principal, command.providerId);
    } catch (error) {
      // Refused before any transaction exists; the audit row is the only record that the attempt happened.
      if (error instanceof ContractError || error instanceof ForbiddenError) {
        await this.audit.recordOutside({
          source: 'HTTP',
          actor: principal.clientId,
          operation: 'SUBMIT_WAGER',
          outcome: 'CONTRACT_ERROR',
          code: error.code,
          correlationId: request.correlationId,
          occurredAt: this.clock.now(),
          ...(typeof idempotencyKey === 'string' && idempotencyKey.length <= 256 ? { idempotencyKey } : {}),
        });
      }
      throw error;
    }

    const result = await this.processWager.execute(command, {
      source: 'HTTP',
      actor: principal.clientId,
      correlationId: request.correlationId,
    });
    void reply.status(statusForWager(result));
    return {
      ...(result.transactionId === undefined ? {} : { transactionId: result.transactionId }),
      ...(result.status === undefined ? {} : { status: result.status }),
      ...(result.balance === undefined ? {} : { balance: result.balance }),
      ...(result.failureCode === undefined ? {} : { failureCode: result.failureCode }),
      idempotentReplay: result.idempotentReplay,
    };
  }

  @Get('wagering/transactions/:transactionId')
  @Roles('provider', 'operator')
  async get(@Param('transactionId') transactionId: string, @Req() request: FastifyRequest): Promise<TransactionView> {
    const view = await this.queries.getTransaction(uuidParam(transactionId, 'transactionId'));
    // Another provider's transaction answers 404, so ids cannot be probed across providers.
    if (!canSee(principalOf(request), view.providerId)) {
      throw new TransactionNotFoundError(`Transaction ${transactionId} does not exist`);
    }
    return view;
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  @Roles('provider', 'operator')
  async getByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
    @Req() request: FastifyRequest,
  ): Promise<TransactionView> {
    assertActsFor(principalOf(request), identifierParam(providerId, 'providerId'));
    return this.queries.getTransactionByExternalId(
      providerId,
      identifierParam(externalTransactionId, 'externalTransactionId'),
    );
  }
}
