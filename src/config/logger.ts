import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { getContext } from '../infrastructure/observability/context.js';
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

/**
 * JSON to stdout in every environment that ships logs (collectors parse it); `LOG_FORMAT=pretty`
 * is a local-development convenience. `destination` lets tests capture output.
 */
export function createLogger(
  env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV' | 'LOG_FORMAT'>,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    base: { service: 'content-review-service' },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    // Every line written inside a request or job carries its correlation ids.
    mixin: () => ({ ...getContext() }),
  };
  if (destination) return pino(options, destination);
  if (env.LOG_FORMAT === 'pretty') {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
        },
      },
    });
  }
  return pino(options);
}

export type { Logger };
