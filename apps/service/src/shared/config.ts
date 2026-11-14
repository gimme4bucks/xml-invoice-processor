import { z } from 'zod';

/** `https://host[:port]` exactly as a browser sends it in `Origin`: no path, no trailing slash. */
const isOrigin = (value: string) => {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
};

/** Environment configuration, validated once at startup. Secrets only come from the environment. */
const schema = z.object({
  ADAPTERS: z.enum(['in-memory', 'real']).default('real'),
  API_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().optional(),
  AMQP_URL: z.string().optional(),
  // Required by the API (checked in remoteAuthOptions), not by the worker.
  AUTH_ISSUER: z.string().min(1).optional(),
  AUTH_JWKS_URL: z.url().optional(),
  AUTH_AUDIENCE: z.string().min(1).optional(),
  /** The IdP's token endpoint, for the Swagger UI's Authorize button (ADR 0019). Unset: no button. */
  AUTH_TOKEN_URL: z.url().optional(),
  /** Requests per minute per organisation (per API instance). */
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  /** Behind exactly one reverse proxy (the edge in compose): believe its X-Forwarded-* headers. */
  TRUST_PROXY: z.stringbool().default(false),
  /** Strict-Transport-Security max-age: a year in production, short for a local stack. */
  HSTS_MAX_AGE_SECONDS: z.coerce.number().int().nonnegative().default(31_536_000),
  /** Browser origins of the support app, comma-separated (ADR 0017). Empty: CORS stays off. */
  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.string().refine(isOrigin, 'must be an origin like https://app.example.com'))),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return schema.parse(env);
}
