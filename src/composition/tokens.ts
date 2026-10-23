/** Injection tokens for the composition root. Application classes stay framework-free, so Nest wires them here. */
export const TOKENS = {
  config: Symbol('AppConfig'),
  pino: Symbol('Pino'),
  logger: Symbol('Logger'),
  metrics: Symbol('Metrics'),
  orm: Symbol('MikroORM'),
  runner: Symbol('TransactionRunner'),
  clock: Symbol('Clock'),
  ids: Symbol('IdGenerator'),
  audit: Symbol('AuditRecorder'),
  identity: Symbol('IdentityVerifier'),
  sqs: Symbol('SQSClient'),
  openWallet: Symbol('OpenWallet'),
  processWager: Symbol('ProcessWagerTransaction'),
  walletQueries: Symbol('WalletQueries'),
  wagerQueries: Symbol('WagerQueries'),
  reconcileWallet: Symbol('ReconcileWallet'),
} as const;
