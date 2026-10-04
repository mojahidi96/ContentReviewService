import { pino, type Logger } from 'pino';
import type { Env } from './env.js';

/**
 * Defense in depth: request/response serializers already avoid headers and bodies,
 * but any object logged with these keys is censored.
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'headers.cookie',
  'headers.authorization',
  'password',
  'passwordHash',
  'token',
  'csrfToken',
  'content',
  'originalText',
  'suggestedText',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.csrfToken',
  '*.content',
  '*.originalText',
  '*.suggestedText',
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    base: { service: 'content-review-service' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}

export type { Logger };
