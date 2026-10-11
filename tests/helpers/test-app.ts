import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import type { DestinationStream } from 'pino';
import type { Response as AgentResponse } from 'superagent';
import supertest from 'supertest';
import { inject } from 'vitest';
import { createApp } from '../../src/app.js';
import { ensureIndexes } from '../../src/config/database.js';
import { loadEnv, type Env } from '../../src/config/env.js';
import { createLogger } from '../../src/config/logger.js';
import { createContainer, type Container } from '../../src/container.js';
import type { EmailService } from '../../src/infrastructure/email/email.service.js';
import { NoopMetrics, type MetricsRecorder } from '../../src/infrastructure/metrics/metrics.js';
import { MockPythonLlmClient } from '../../src/integrations/python-llm/mock-llm-client.js';
import type { PythonLlmClient } from '../../src/integrations/python-llm/llm-client.js';
import { ReviewModel, type ReviewRecord } from '../../src/modules/reviews/review.model.js';
import { isTerminalReviewStatus } from '../../src/modules/reviews/review-state.js';
import '../../src/shared/types/express.js';

export const ORIGIN = 'http://localhost:4200';
export const PASSWORD = 'correct horse battery staple';

export const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  MONGODB_URI: 'mongodb://127.0.0.1:27017/unused',
  FRONTEND_ORIGIN: ORIGIN,
  AUTH_JWT_SECRET: 'test-jwt-secret-0123456789abcdef0123456789',
  CSRF_SECRET: 'test-csrf-secret-0123456789abcdef012345678',
  PYTHON_LLM_MODE: 'mock',
  BCRYPT_ROUNDS: '4',
  WORKER_ENABLED: 'false',
  LOG_LEVEL: 'silent',
  RATE_LIMIT_MAX: '100000',
  AUTH_RATE_LIMIT_MAX: '100000',
  JOB_MAX_ATTEMPTS: '3',
  JOB_BACKOFF_BASE_MS: '10',
  JOB_BACKOFF_MAX_MS: '20',
  JOB_POLL_INTERVAL_MS: '50',
  SSE_HEARTBEAT_MS: '1000',
  SSE_POLL_INTERVAL_MS: '100',
};

export function testEnv(overrides: Record<string, string> = {}): Env {
  return loadEnv({ ...TEST_ENV, ...overrides });
}

export async function connectTestDb(): Promise<void> {
  await mongoose.connect(inject('mongoUri'), { dbName: `test_${randomUUID().slice(0, 8)}` });
  await ensureIndexes();
}

export async function clearTestDb(): Promise<void> {
  const collections = Object.values(mongoose.connection.collections);
  await Promise.all(collections.map((c) => c.deleteMany({})));
}

export async function disconnectTestDb(): Promise<void> {
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

export interface TestApp {
  app: ReturnType<typeof createApp>;
  container: Container;
  llm: MockPythonLlmClient;
}

export function createTestApp(
  options: {
    env?: Record<string, string>;
    llmClient?: PythonLlmClient;
    metrics?: MetricsRecorder;
    emailService?: EmailService;
    logDestination?: DestinationStream;
  } = {},
): TestApp {
  const env = testEnv(options.env);
  const llm = new MockPythonLlmClient();
  const container = createContainer(env, createLogger(env, options.logDestination), {
    llmClient: options.llmClient ?? llm,
    metrics: options.metrics ?? new NoopMetrics(),
    ...(options.emailService ? { emailService: options.emailService } : {}),
  });
  return { app: createApp(container), container, llm };
}

export type Agent = ReturnType<typeof supertest.agent>;

export function newAgent(app: TestApp['app']): Agent {
  return supertest.agent(app).set('Origin', ORIGIN);
}

export async function fetchCsrf(agent: Agent): Promise<string> {
  const res = await agent.get('/api/v1/auth/csrf').expect(200);
  return res.body.csrfToken as string;
}

/** Registers a fresh user on `agent` (cookies persist) and returns the post-login CSRF token. */
export async function registerUser(
  agent: Agent,
  overrides: Partial<{ email: string; password: string; displayName: string }> = {},
): Promise<{ csrfToken: string; userId: string; email: string }> {
  const csrf = await fetchCsrf(agent);
  const email = overrides.email ?? `user-${randomUUID().slice(0, 8)}@example.com`;
  const res = await agent
    .post('/api/v1/auth/register')
    .set('X-CSRF-Token', csrf)
    .send({
      email,
      password: overrides.password ?? PASSWORD,
      displayName: overrides.displayName ?? 'Test User',
    })
    .expect(201);
  return { csrfToken: res.body.csrfToken as string, userId: res.body.user.id as string, email };
}

export const SAMPLE_CONTENT = 'The report have several mistake. Please recieve teh files, damn it.';

export async function createReview(
  agent: Agent,
  csrfToken: string,
  body: Partial<{
    documentTitle: string;
    content: string;
    categories: string[];
    model: string;
  }> = {},
): Promise<{ reviewId: string; eventsUrl: string }> {
  const res = await agent
    .post('/api/v1/reviews')
    .set('X-CSRF-Token', csrfToken)
    .send({
      documentTitle: 'Quarterly Business Report',
      content: SAMPLE_CONTENT,
      categories: ['grammar', 'spelling', 'profanity'],
      ...body,
    })
    .expect(202);
  return res.body as { reviewId: string; eventsUrl: string };
}

/** Runs the worker until the review reaches a terminal state (retries have short backoff in tests). */
export async function processUntilSettled(
  container: Container,
  reviewId: string,
  timeoutMs = 5_000,
): Promise<ReviewRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await container.worker.drain();
    const review = await ReviewModel.findById(reviewId).lean<ReviewRecord>();
    if (!review) throw new Error('review disappeared');
    if (isTerminalReviewStatus(review.status)) return review;
    if (Date.now() > deadline)
      throw new Error(`review still ${review.status} after ${timeoutMs}ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

export interface ParsedSseEvent {
  id: number | undefined;
  event: string | undefined;
  data: any;
}

export function parseSse(text: string): {
  events: ParsedSseEvent[];
  comments: string[];
  retry?: number;
} {
  const events: ParsedSseEvent[] = [];
  const comments: string[] = [];
  let retry: number | undefined;
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const ev: { id?: number; event?: string; data?: string } = {};
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) comments.push(line.slice(1).trim());
      else if (line.startsWith('id: ')) ev.id = Number(line.slice(4));
      else if (line.startsWith('event: ')) ev.event = line.slice(7);
      else if (line.startsWith('data: ')) ev.data = line.slice(6);
      else if (line.startsWith('retry: ')) retry = Number(line.slice(7));
    }
    if (ev.event) events.push({ id: ev.id, event: ev.event, data: JSON.parse(ev.data ?? 'null') });
  }
  return { events, comments, ...(retry === undefined ? {} : { retry }) };
}

/** Superagent parser that buffers a text/event-stream body as a string. */
export function sseParser(
  res: AgentResponse,
  callback: (err: Error | null, body: string) => void,
): void {
  // At parse time superagent hands over the raw IncomingMessage stream.
  const stream = res as unknown as NodeJS.ReadableStream;
  let body = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => (body += chunk));
  stream.on('end', () => callback(null, body));
}
