import 'reflect-metadata';
import { loadConfig } from './config/config';
import { createHttpApp } from './interface/http/create-http-app';
import { createLogger } from './infrastructure/observability/logger';

const config = loadConfig();
const pino = createLogger({ level: config.logLevel });

process.on('unhandledRejection', (reason) => {
  pino.error({ err: reason }, 'unhandled promise rejection');
});

const app = await createHttpApp(config, { pino });
await app.listen({ port: config.port, host: '0.0.0.0' });
pino.info({ port: config.port, roles: [...config.roles] }, 'wagering service started');

let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  pino.info({ signal }, 'shutting down');
  // Hard stop if graceful shutdown hangs; SQS hands back anything unacknowledged after its visibility timeout.
  const deadline = setTimeout(() => process.exit(1), 30_000);
  void app
    .close()
    .then(() => {
      clearTimeout(deadline);
      pino.flush();
      process.exit(0);
    })
    .catch((error: unknown) => {
      pino.error({ err: error }, 'shutdown failed');
      process.exit(1);
    });
};
process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});
process.on('SIGINT', () => {
  shutdown('SIGINT');
});
