import { z } from 'zod';
import { FAULT_POINTS, type FaultPoint } from '../application/ports/messaging';

export const APP_ROLES = ['api', 'consumer', 'outbox', 'pending-reference'] as const;
export type AppRole = (typeof APP_ROLES)[number];


const csv = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    DATABASE_URL: z.url(),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
    AWS_REGION: z.string().min(1),
    SQS_ENDPOINT: z.url().optional(),
    WAGER_QUEUE_URL: z.url(),
    WAGER_DLQ_URL: z.url(),
    EVENTS_QUEUE_URL: z.url(),
    APP_ROLES: z
      .string()
      .default(APP_ROLES.join(','))
      .transform(csv)
      .pipe(z.array(z.enum(APP_ROLES)).min(1)),
    SUPPORTED_CURRENCIES: z
      .string()
      .default('BRL,USD,EUR')
      .transform(csv)
      .pipe(z.array(z.string().regex(/^[A-Z]{3}$/)).min(1)),
    JWKS_URL: z.url(),
    AUTH_ISSUER: z.string().min(1),
    AUTH_AUDIENCE: z.string().min(1),
    LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    FAULT_INJECTION: z.enum(FAULT_POINTS).optional(),
  })
  .refine((env) => env.FAULT_INJECTION === undefined || env.NODE_ENV === 'test', {
    path: ['FAULT_INJECTION'],
    message: 'fault injection is only allowed when NODE_ENV=test',
  });

export interface AppConfig {
  readonly env: 'development' | 'test' | 'production';
  readonly port: number;
  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly awsRegion: string;
  readonly sqsEndpoint: string | undefined;
  readonly wagerQueueUrl: string;
  readonly wagerDlqUrl: string;
  readonly eventsQueueUrl: string;
  readonly roles: ReadonlySet<AppRole>;
  readonly supportedCurrencies: ReadonlySet<string>;
  readonly jwksUrl: string;
  readonly authIssuer: string;
  readonly authAudience: string;
  readonly logLevel: string;
  readonly faultInjection: FaultPoint | undefined;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment: ${details}`);
  }

  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databasePoolMax: e.DATABASE_POOL_MAX,
    awsRegion: e.AWS_REGION,
    sqsEndpoint: e.SQS_ENDPOINT,
    wagerQueueUrl: e.WAGER_QUEUE_URL,
    wagerDlqUrl: e.WAGER_DLQ_URL,
    eventsQueueUrl: e.EVENTS_QUEUE_URL,
    roles: new Set(e.APP_ROLES),
    supportedCurrencies: new Set(e.SUPPORTED_CURRENCIES),
    jwksUrl: e.JWKS_URL,
    authIssuer: e.AUTH_ISSUER,
    authAudience: e.AUTH_AUDIENCE,
    logLevel: e.LOG_LEVEL,
    faultInjection: e.FAULT_INJECTION,
  };
}
