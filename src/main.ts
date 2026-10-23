import 'reflect-metadata';
import { loadConfig } from './config/config';
import { createHttpApp } from './interface/http/create-http-app';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await createHttpApp(config);
  app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
  await app.listen({ port: config.port, host: '0.0.0.0' });
}

await bootstrap();
