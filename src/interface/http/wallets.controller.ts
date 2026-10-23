import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { OpenWallet } from '../../application/wallets/open-wallet';
import type { ReconcileWallet, ReconciliationView } from '../../application/wallets/reconcile-wallet';
import type { LedgerPage, WalletQueries } from '../../application/wallets/wallet-queries';
import type { WalletView } from '../../application/wallets/wallet-view';
import { TOKENS } from '../../composition/tokens';
import { Roles } from './auth.guard';
import { principalOf } from './request-context';
import { cursorQuery, limitQuery, openWalletBody, parseBody, uuidParam } from './schemas';

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(TOKENS.openWallet) private readonly openWallet: OpenWallet,
    @Inject(TOKENS.walletQueries) private readonly queries: WalletQueries,
    @Inject(TOKENS.reconcileWallet) private readonly reconcile: ReconcileWallet,
  ) {}

  @Post()
  @Roles('operator')
  @HttpCode(201)
  async open(@Body() body: unknown, @Req() request: FastifyRequest): Promise<WalletView> {
    const input = parseBody(openWalletBody, body);
    return this.openWallet.execute({
      playerId: input.playerId,
      initialBalance: input.initialBalance,
      actor: principalOf(request).clientId,
      correlationId: request.correlationId,
    });
  }

  @Get(':walletId')
  @Roles('operator', 'provider')
  async get(@Param('walletId') walletId: string): Promise<WalletView> {
    return this.queries.getWallet(uuidParam(walletId, 'walletId'));
  }

  @Get(':walletId/ledger')
  @Roles('operator')
  async ledger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: unknown,
    @Query('limit') limit: unknown,
  ): Promise<LedgerPage> {
    return this.queries.listLedger(uuidParam(walletId, 'walletId'), cursorQuery(cursor), limitQuery(limit));
  }

  @Post(':walletId/reconciliation')
  @Roles('operator')
  @HttpCode(200)
  async reconciliation(@Param('walletId') walletId: string, @Req() request: FastifyRequest): Promise<ReconciliationView> {
    return this.reconcile.execute(uuidParam(walletId, 'walletId'), principalOf(request).clientId, request.correlationId);
  }
}
