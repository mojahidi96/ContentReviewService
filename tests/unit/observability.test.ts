import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadEnv } from '../../src/config/env.js';
import { createLogger } from '../../src/config/logger.js';
import { PrometheusMetrics } from '../../src/infrastructure/metrics/prometheus-metrics.js';
import {
  getContext,
  runWithContext,
  setContextValue,
} from '../../src/infrastructure/observability/context.js';

const baseEnv = {
  MONGODB_URI: 'mongodb://localhost:27017/x',
  FRONTEND_ORIGIN: 'http://localhost:4200',
  AUTH_JWT_SECRET: 'a'.repeat(40),
  CSRF_SECRET: 'b'.repeat(40),
  PYTHON_LLM_MODE: 'mock',
};

function captureLogger() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(JSON.parse(chunk.toString()) as Record<string, unknown>);
      cb();
    },
  });
  const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test', LOG_FORMAT: 'json' }, stream);
  return { logger, lines };
}

describe('log context', () => {
  it('propagates across awaits and isolates concurrent contexts', async () => {
    const seen: (string | undefined)[] = [];
    await Promise.all(
      ['a', 'b'].map((id) =>
        runWithContext({ requestId: id }, async () => {
          await new Promise((r) => setTimeout(r, 5));
          seen.push(getContext()?.requestId);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['a', 'b']);
    expect(getContext()).toBeUndefined();
  });

  it('adds correlation ids to every log line written inside a context', async () => {
    const { logger, lines } = captureLogger();
    logger.info('outside');
    await runWithContext({ requestId: 'req-12345678' }, async () => {
      await Promise.resolve();
      setContextValue('userId', 'user-1');
      logger.child({ component: 'x' }).info('inside');
    });
    expect(lines[0]).not.toHaveProperty('requestId');
    expect(lines[1]).toMatchObject({ requestId: 'req-12345678', userId: 'user-1', component: 'x' });
  });

  it('still redacts sensitive fields', () => {
    const { logger, lines } = captureLogger();
    logger.info({ content: 'secret document', password: 'pw', reviewId: 'r1' }, 'x');
    expect(lines[0]).toMatchObject({
      content: '[REDACTED]',
      password: '[REDACTED]',
      reviewId: 'r1',
    });
  });
});

describe('PrometheusMetrics', () => {
  it('exports HTTP, job, LLM, SSE and queue series', async () => {
    const metrics = new PrometheusMetrics({
      defaultMetrics: false,
      queueDepth: () => Promise.resolve({ queued: 2, running: 1 }),
    });
    metrics.observeHttpRequest({
      method: 'GET',
      route: '/api/v1/reviews/:reviewId',
      statusCode: 200,
      durationMs: 42,
    });
    metrics.observeJob({ outcome: 'completed', durationMs: 1500, attempt: 1 });
    metrics.observeLlmCall({ outcome: 'error', durationMs: 900, errorCode: 'LLM_SERVICE_TIMEOUT' });
    metrics.setActiveSseConnections(3);

    const text = await metrics.registry.metrics();
    expect(text).toContain(
      'http_requests_total{method="GET",route="/api/v1/reviews/:reviewId",status_code="200",service="content-review-service"} 1',
    );
    // 42 ms falls in the 0.05 s bucket.
    expect(text).toMatch(/http_request_duration_seconds_bucket\{[^}]*le="0\.05"[^}]*\} 1/);
    expect(text).toMatch(/http_request_duration_seconds_bucket\{[^}]*le="0\.025"[^}]*\} 0/);
    expect(text).toContain(
      'review_jobs_total{outcome="completed",service="content-review-service"} 1',
    );
    expect(text).toContain(
      'llm_calls_total{outcome="error",error_code="LLM_SERVICE_TIMEOUT",service="content-review-service"} 1',
    );
    expect(text).toContain('sse_active_connections{service="content-review-service"} 3');
    expect(text).toContain('review_jobs_queue{status="queued",service="content-review-service"} 2');
  });

  it('keeps registries isolated and tolerates queue read failures', async () => {
    const a = new PrometheusMetrics({
      defaultMetrics: false,
      queueDepth: () => Promise.reject(new Error('db down')),
    });
    const b = new PrometheusMetrics({ defaultMetrics: false });
    a.setActiveSseConnections(5);
    expect(await b.registry.metrics()).toContain(
      'sse_active_connections{service="content-review-service"} 0',
    );
    await expect(a.registry.metrics()).resolves.toContain('# TYPE review_jobs_queue gauge');
  });

  it('collects default process metrics when enabled', async () => {
    const text = await new PrometheusMetrics().registry.metrics();
    expect(text).toContain('process_cpu_user_seconds_total');
    expect(text).toContain('nodejs_eventloop_lag_seconds');
  });
});

describe('observability configuration', () => {
  it('defaults to JSON logs and an internal metrics port', () => {
    expect(loadEnv(baseEnv)).toMatchObject({
      LOG_FORMAT: 'json',
      METRICS_ENABLED: true,
      METRICS_PORT: 9464,
    });
  });

  it('rejects pretty logs in production and a metrics port equal to the API port', () => {
    const prod = {
      ...baseEnv,
      NODE_ENV: 'production',
      FRONTEND_ORIGIN: 'https://app.example.com',
      AUTH_COOKIE_SECURE: 'true',
      PYTHON_LLM_MODE: 'http',
      INTERNAL_SERVICE_TOKEN: 'c'.repeat(32),
    };
    expect(() => loadEnv({ ...prod, LOG_FORMAT: 'pretty' })).toThrow(/LOG_FORMAT/);
    expect(() => loadEnv({ ...baseEnv, PORT: '9464' })).toThrow(/METRICS_PORT/);
    expect(() => loadEnv({ ...baseEnv, PORT: '9464', METRICS_ENABLED: 'false' })).not.toThrow();
  });
});
