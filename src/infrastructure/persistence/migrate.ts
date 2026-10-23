import { MikroORM } from '@mikro-orm/postgresql';
import { loadConfig } from '../../config/config';
import { createOrmConfig } from './mikro-orm.config';

/** `bun run migrate:up` applies every pending migration; `migrate:down` reverts the last one. */
const direction = process.argv[2];
if (direction !== 'up' && direction !== 'down') {
  process.stderr.write('usage: migrate.ts up|down\n');
  process.exit(2);
}

const config = loadConfig();
const orm = await MikroORM.init(createOrmConfig({ databaseUrl: config.databaseUrl, poolMax: 2 }));
try {
  const applied = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  process.stdout.write(`${direction}: ${applied.map((m) => m.name).join(', ') || 'nothing to do'}\n`);
} finally {
  await orm.close(true);
}
