import { z } from 'zod';

/** Environment configuration, validated once at startup. Secrets only come from the environment. */
const schema = z.object({
  ADAPTERS: z.enum(['in-memory', 'real']).default('real'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().optional(),
  AMQP_URL: z.string().optional(),
  AUTH_ISSUER: z.string().optional(),
  AUTH_JWKS_URL: z.string().optional(),
  AUTH_AUDIENCE: z.string().optional(),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return schema.parse(env);
}
