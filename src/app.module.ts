import { Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { SQSClient } from '@aws-sdk/client-sqs';
import type { Logger as Pino } from 'pino';
import { AuditRecorder } from './application/audit/audit-recorder';
import type { Clock, IdGenerator } from './application/ports/clock';
import type { Logger, Metrics } from './application/ports/observability';
import type { TransactionRunner } from './application/ports/repositories';
import { ProcessWagerTransaction } from './application/wagering/process-wager-transaction';
import { WagerQueries } from './application/wagering/wager-queries';
import { OpenWallet } from './application/wallets/open-wallet';
import { ReconcileWallet } from './application/wallets/reconcile-wallet';
import { WalletQueries } from './application/wallets/wallet-queries';
import { TOKENS } from './composition/tokens';
import type { AppConfig } from './config/config';
import { JwtVerifier } from './infrastructure/auth/jwt-verifier';
import { createLogger, PinoLogger } from './infrastructure/observability/logger';
import { PrometheusMetrics } from './infrastructure/observability/metrics';
import { createOrmConfig } from './infrastructure/persistence/mikro-orm.config';
import { PERSISTENCE_RECORDS } from './infrastructure/persistence/records';
import { MikroOrmTransactionRunner } from './infrastructure/persistence/transaction-runner';
import { createSqsClient } from './infrastructure/sqs/sqs-client';
import { SystemClock, UuidV7Generator } from './infrastructure/system';
import { AuthGuard } from './interface/http/auth.guard';
import { HealthController } from './interface/http/health.controller';
import { ProblemFilter } from './interface/http/problem.filter';
import { WageringController } from './interface/http/wagering.controller';
import { WalletsController } from './interface/http/wallets.controller';

@Injectable()
class InfrastructureLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(TOKENS.orm) private readonly orm: MikroORM,
    @Inject(TOKENS.sqs) private readonly sqs: SQSClient,
    @Inject(TOKENS.pino) private readonly pino: Pino,
  ) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
    this.sqs.destroy();
    this.pino.flush();
  }
}

export interface AppOverrides {
  pino?: Pino;
}

function providers(config: AppConfig, overrides: AppOverrides): Provider[] {
  return [
    { provide: TOKENS.config, useValue: config },
    { provide: TOKENS.pino, useValue: overrides.pino ?? createLogger({ level: config.logLevel }) },
    { provide: TOKENS.logger, useFactory: (pino: Pino) => new PinoLogger(pino), inject: [TOKENS.pino] },
    { provide: TOKENS.metrics, useFactory: () => new PrometheusMetrics({ defaultMetrics: true }) },
    { provide: TOKENS.clock, useClass: SystemClock },
    { provide: TOKENS.ids, useClass: UuidV7Generator },
    {
      provide: TOKENS.orm,
      useFactory: () =>
        MikroORM.init(
          createOrmConfig({
            databaseUrl: config.databaseUrl,
            poolMax: config.databasePoolMax,
            entities: PERSISTENCE_RECORDS,
          }),
        ),
    },
    {
      provide: TOKENS.runner,
      useFactory: (orm: MikroORM) => new MikroOrmTransactionRunner(orm, { lockTimeoutMs: 5_000, statementTimeoutMs: 10_000 }),
      inject: [TOKENS.orm],
    },
    { provide: TOKENS.sqs, useFactory: () => createSqsClient(config) },
    {
      provide: TOKENS.identity,
      useFactory: () =>
        new JwtVerifier({ jwksUrl: config.jwksUrl, issuer: config.authIssuer, audience: config.authAudience }),
    },
    {
      provide: TOKENS.audit,
      useFactory: (runner: TransactionRunner, logger: Logger, metrics: Metrics) =>
        new AuditRecorder(runner, logger, metrics),
      inject: [TOKENS.runner, TOKENS.logger, TOKENS.metrics],
    },
    {
      provide: TOKENS.openWallet,
      useFactory: (runner: TransactionRunner, audit: AuditRecorder, clock: Clock, ids: IdGenerator) =>
        new OpenWallet(runner, audit, clock, ids, config.supportedCurrencies),
      inject: [TOKENS.runner, TOKENS.audit, TOKENS.clock, TOKENS.ids],
    },
    {
      provide: TOKENS.processWager,
      useFactory: (
        runner: TransactionRunner,
        audit: AuditRecorder,
        clock: Clock,
        ids: IdGenerator,
        logger: Logger,
        metrics: Metrics,
      ) => new ProcessWagerTransaction(runner, audit, clock, ids, logger, metrics),
      inject: [TOKENS.runner, TOKENS.audit, TOKENS.clock, TOKENS.ids, TOKENS.logger, TOKENS.metrics],
    },
    {
      provide: TOKENS.walletQueries,
      useFactory: (runner: TransactionRunner) => new WalletQueries(runner),
      inject: [TOKENS.runner],
    },
    {
      provide: TOKENS.wagerQueries,
      useFactory: (runner: TransactionRunner) => new WagerQueries(runner),
      inject: [TOKENS.runner],
    },
    {
      provide: TOKENS.reconcileWallet,
      useFactory: (runner: TransactionRunner, clock: Clock, ids: IdGenerator, logger: Logger, metrics: Metrics) =>
        new ReconcileWallet(runner, clock, ids, logger, metrics),
      inject: [TOKENS.runner, TOKENS.clock, TOKENS.ids, TOKENS.logger, TOKENS.metrics],
    },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_FILTER, useClass: ProblemFilter },
    InfrastructureLifecycle,
  ];
}

/** Composition root: the only place that knows which adapter implements which port. */
@Module({})
export class AppModule {
  static register(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: config.roles.has('api') ? [WalletsController, WageringController, HealthController] : [HealthController],
      providers: providers(config, overrides),
      exports: Object.values(TOKENS),
    };
  }
}
