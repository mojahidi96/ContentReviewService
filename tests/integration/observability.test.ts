import { Writable } from 'node:stream';
import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createMetricsApp } from '../../src/infrastructure/metrics/metrics-server.js';
import { PrometheusMetrics } from '../../src/infrastructure/metrics/prometheus-metrics.js';
import { createMetrics } from '../../src/container.js';
import {
  clearTestDb,
  connectTestDb,
  createReview,
  createTestApp,
  disconnectTestDb,
  newAgent,
  processUntilSettled,
  registerUser,
  SAMPLE_CONTENT,
  testEnv,
  type TestApp,
} from '../helpers/test-app.js';
import { createLogger } from '../../src/config/logger.js';

type LogLine = Record<string, unknown>;

describe('observability', () => {
  let t: TestApp;
  let metrics: PrometheusMetrics;
  const lines: LogLine[] = [];

  beforeAll(async () => {
    await connectTestDb();
    metrics = createMetrics(testEnv(), createLogger(testEnv())) as PrometheusMetrics;
    const destination = new Writable({
      write(chunk: Buffer, _enc, cb) {
        for (const line of chunk.toString().split('\n').filter(Boolean)) {
          lines.push(JSON.parse(line) as LogLine);
        }
        cb();
      },
    });
    t = createTestApp({ metrics, logDestination: destination, env: { LOG_LEVEL: 'info' } });
  });
  beforeEach(async () => {
    await clearTestDb();
    lines.length = 0;
  });
  afterAll(disconnectTestDb);

  const scrape = async () =>
    (await supertest(createMetricsApp(metrics.registry)).get('/metrics').expect(200)).text;

  it('uses Prometheus metrics with an isolated registry by default', () => {
    expect(metrics).toBeInstanceOf(PrometheusMetrics);
  });

  it('labels HTTP metrics with route templates, never raw ids', async () => {
    const agent = newAgent(t.app);
    const { csrfToken } = await registerUser(agent);
    const { reviewId } = await createReview(agent, csrfToken);
    await agent.get(`/api/v1/reviews/${reviewId}`).expect(200);
    await agent.get('/api/v1/reviews/not-an-id').expect(400); // fails after matching the route
    await agent.get('/api/v1/nope').expect(404);

    const text = await scrape();
    expect(text).not.toContain(reviewId);
    expect(text).toMatch(
      /http_requests_total\{method="GET",route="\/api\/v1\/reviews\/:reviewId",status_code="200"/,
    );
    expect(text).toMatch(
      /http_requests_total\{method="GET",route="\/api\/v1\/reviews\/:reviewId",status_code="400"/,
    );
    expect(text).toMatch(
      /http_requests_total\{method="POST",route="\/api\/v1\/reviews",status_code="202"/,
    );
    expect(text).toMatch(/http_requests_total\{method="GET",route="unmatched",status_code="404"/);
  });

  it('records job, LLM and queue metrics after processing', async () => {
    const agent = newAgent(t.app);
    const { csrfToken } = await registerUser(agent);
    const { reviewId } = await createReview(agent, csrfToken);
    await processUntilSettled(t.container, reviewId);

    const text = await scrape();
    expect(text).toMatch(
      /review_jobs_total\{outcome="completed",service="content-review-service"\} [1-9]/,
    );
    expect(text).toMatch(
      /llm_calls_total\{outcome="success",error_code="none",service="content-review-service"\} [1-9]/,
    );
    expect(text).toContain(
      'review_jobs_queue{status="succeeded",service="content-review-service"} 1',
    );
    expect(text).toContain('process_resident_memory_bytes');
  });

  it('serves only /metrics on the metrics app, and not on the public app', async () => {
    await supertest(createMetricsApp(metrics.registry)).get('/').expect(404);
    await supertest(t.app).get('/metrics').expect(404);
  });

  it('tags request logs with requestId and userId, and job logs with review/job ids', async () => {
    const agent = newAgent(t.app);
    const { csrfToken, userId } = await registerUser(agent);
    const create = await agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', csrfToken)
      .set('X-Request-Id', 'trace-abc-123456')
      .send({ documentTitle: 'Doc', content: SAMPLE_CONTENT, categories: ['grammar'] })
      .expect(202);
    const reviewId = create.body.reviewId as string;
    await processUntilSettled(t.container, reviewId);

    const requestLines = lines.filter((l) => l.requestId === 'trace-abc-123456');
    expect(requestLines.length).toBeGreaterThan(0);
    expect(requestLines.every((l) => l.userId === userId)).toBe(true);

    const jobLine = lines.find((l) => l.msg === 'Review completed');
    expect(jobLine).toMatchObject({ reviewId, jobId: expect.any(String), attempt: 1 });

    // Document content never reaches the logs.
    expect(JSON.stringify(lines)).not.toContain('several mistake');
  });
});
