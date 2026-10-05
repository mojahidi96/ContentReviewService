import { z } from 'zod';

const PLACEHOLDER_PATTERN = /replace_with|change[-_]?me|dev[-_]only/i;

/** Parses "900", "900s", "15m", "12h", "7d" into seconds. */
export function parseDurationSeconds(value: string): number | null {
  const match = /^(\d+)\s*([smhd]?)$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? '';
  const multiplier = { '': 1, s: 1, m: 60, h: 3600, d: 86400 }[unit] ?? 1;
  return amount * multiplier;
}

const duration = z.string().transform((value, ctx) => {
  const seconds = parseDurationSeconds(value);
  if (seconds === null || seconds <= 0) {
    ctx.addIssue({ code: 'custom', message: 'Expected a duration such as 900, 15m, 12h or 7d' });
    return z.NEVER;
  }
  return seconds;
});

const int = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
const bool = z.stringbool();

const originList = z.string().transform((value, ctx) => {
  const origins = value
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      ctx.addIssue({ code: 'custom', message: `Invalid origin: ${origin}` });
      return z.NEVER;
    }
    if (parsed.origin !== origin) {
      ctx.addIssue({
        code: 'custom',
        message: `Origin must be scheme://host[:port] with no path or trailing slash: ${origin}`,
      });
      return z.NEVER;
    }
  }
  if (origins.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'At least one origin is required' });
    return z.NEVER;
  }
  return origins;
});

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(1, 65535).default(3000),
    HOST: z.string().default('0.0.0.0'),
    TRUST_PROXY: z.string().default('false'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

    METRICS_ENABLED: bool.default(true),
    METRICS_HOST: z.string().default('0.0.0.0'),
    METRICS_PORT: int(1, 65535).default(9464),

    MONGODB_URI: z.url({ protocol: /^mongodb(\+srv)?$/ }),

    FRONTEND_ORIGIN: originList,

    AUTH_JWT_SECRET: z.string().min(32, 'AUTH_JWT_SECRET must be at least 32 characters'),
    AUTH_JWT_ISSUER: z.string().default('content-review-service'),
    AUTH_JWT_AUDIENCE: z.string().default('content-review-ui'),
    AUTH_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default('content_review_session'),
    AUTH_COOKIE_SECURE: bool.default(false),
    AUTH_COOKIE_SAMESITE: z.enum(['strict', 'lax', 'none']).default('lax'),
    AUTH_TOKEN_TTL: duration.default(900),
    BCRYPT_ROUNDS: int(4, 15).default(12),

    CSRF_SECRET: z.string().min(32, 'CSRF_SECRET must be at least 32 characters'),
    CSRF_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default('content_review_csrf'),

    PYTHON_LLM_MODE: z.enum(['http', 'mock']).default('http'),
    PYTHON_LLM_SERVICE_URL: z.url({ protocol: /^https?$/ }).default('http://localhost:8000'),
    PYTHON_LLM_SERVICE_TOKEN: z.string().default(''),
    PYTHON_LLM_TIMEOUT_MS: int(1000, 600_000).default(60_000),
    PYTHON_LLM_CONNECT_TIMEOUT_MS: int(100, 60_000).default(5_000),
    PYTHON_LLM_HEALTH_CHECK: bool.default(true),

    WORKER_ENABLED: bool.default(true),
    JOB_CONCURRENCY: int(1, 64).default(2),
    JOB_MAX_ATTEMPTS: int(1, 20).default(4),
    JOB_POLL_INTERVAL_MS: int(50, 60_000).default(1_000),
    JOB_LEASE_MS: int(5_000, 3_600_000).optional(),
    JOB_BACKOFF_BASE_MS: int(10, 600_000).default(2_000),
    JOB_BACKOFF_MAX_MS: int(10, 3_600_000).default(60_000),
    JOB_RECOVERY_INTERVAL_MS: int(1_000, 3_600_000).default(30_000),
    JOB_ORPHAN_AGE_MS: int(1_000, 86_400_000).default(60_000),

    REVIEW_MAX_CONTENT_CHARS: int(1, 1_000_000).default(50_000),
    REVIEW_RETENTION_DAYS: int(0, 3650).default(90),
    BODY_LIMIT: z.string().default('512kb'),

    SSE_HEARTBEAT_MS: int(1_000, 300_000).default(15_000),
    SSE_POLL_INTERVAL_MS: int(100, 60_000).default(1_000),
    SSE_RETRY_MS: int(100, 60_000).default(3_000),

    RATE_LIMIT_WINDOW_MS: int(1_000, 86_400_000).default(900_000),
    RATE_LIMIT_MAX: int(1, 1_000_000).default(300),
    AUTH_RATE_LIMIT_MAX: int(1, 1_000_000).default(20),

    SHUTDOWN_GRACE_MS: int(0, 120_000).default(10_000),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_COOKIE_SAMESITE === 'none' && !env.AUTH_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SAMESITE'],
        message: 'SameSite=None requires AUTH_COOKIE_SECURE=true',
      });
    }
    if (env.PYTHON_LLM_MODE === 'http' && env.PYTHON_LLM_SERVICE_TOKEN.length < 16) {
      ctx.addIssue({
        code: 'custom',
        path: ['PYTHON_LLM_SERVICE_TOKEN'],
        message:
          'PYTHON_LLM_SERVICE_TOKEN must be at least 16 characters when PYTHON_LLM_MODE=http',
      });
    }
    if (env.METRICS_ENABLED && env.METRICS_PORT === env.PORT) {
      ctx.addIssue({
        code: 'custom',
        path: ['METRICS_PORT'],
        message: 'METRICS_PORT must differ from PORT so /metrics stays off the public listener',
      });
    }
    if (env.JOB_BACKOFF_MAX_MS < env.JOB_BACKOFF_BASE_MS) {
      ctx.addIssue({
        code: 'custom',
        path: ['JOB_BACKOFF_MAX_MS'],
        message: 'JOB_BACKOFF_MAX_MS must be >= JOB_BACKOFF_BASE_MS',
      });
    }
    if (env.NODE_ENV !== 'production') return;

    // Production hardening: fail fast instead of running with development defaults.
    const secrets = ['AUTH_JWT_SECRET', 'CSRF_SECRET', 'PYTHON_LLM_SERVICE_TOKEN'] as const;
    for (const key of secrets) {
      if (PLACEHOLDER_PATTERN.test(env[key])) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} still has a placeholder value`,
        });
      }
    }
    if (env.AUTH_JWT_SECRET === env.CSRF_SECRET) {
      ctx.addIssue({
        code: 'custom',
        path: ['CSRF_SECRET'],
        message: 'CSRF_SECRET must differ from AUTH_JWT_SECRET',
      });
    }
    if (!env.AUTH_COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['AUTH_COOKIE_SECURE'],
        message: 'AUTH_COOKIE_SECURE must be true in production',
      });
    }
    if (env.LOG_FORMAT !== 'json') {
      ctx.addIssue({
        code: 'custom',
        path: ['LOG_FORMAT'],
        message: 'LOG_FORMAT must be json in production (pino-pretty is a dev dependency)',
      });
    }
    if (env.PYTHON_LLM_MODE !== 'http') {
      ctx.addIssue({
        code: 'custom',
        path: ['PYTHON_LLM_MODE'],
        message: 'The mock LLM client cannot be used in production',
      });
    }
    if (env.FRONTEND_ORIGIN.some((o) => o.startsWith('http://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['FRONTEND_ORIGIN'],
        message: 'Frontend origins must use https in production',
      });
    }
  })
  .transform((env) => ({
    ...env,
    // The job lease must outlive a full Python call so a healthy worker never loses its job.
    JOB_LEASE_MS: env.JOB_LEASE_MS ?? env.PYTHON_LLM_TIMEOUT_MS + 30_000,
    TRUST_PROXY: parseTrustProxy(env.TRUST_PROXY),
  }));

function parseTrustProxy(value: string): boolean | number | string {
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

export type Env = z.infer<typeof envSchema>;

export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid environment configuration:\n  - ${issues.join('\n  - ')}`);
    this.name = 'EnvValidationError';
  }
}

/** Validates configuration. Error messages name variables but never echo their values. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}
