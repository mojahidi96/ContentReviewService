import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReviewJobModel } from '../../src/infrastructure/jobs/job.model.js';
import { HttpPythonLlmClient } from '../../src/integrations/python-llm/http-llm-client.js';
import {
  LlmBadResponseError,
  LlmContentTooLargeError,
  LlmRateLimitedError,
  LlmRejectedError,
  LlmUnavailableError,
} from '../../src/integrations/python-llm/llm.errors.js';
import { MockPythonLlmClient } from '../../src/integrations/python-llm/mock-llm-client.js';
import { ReviewEventModel } from '../../src/modules/reviews/review-events.model.js';
import { ReviewModel } from '../../src/modules/reviews/review.model.js';
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
  type Agent,
  type TestApp,
} from '../helpers/test-app.js';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function eventTypes(reviewId: string): Promise<string[]> {
  const events = await ReviewEventModel.find({ reviewId }).sort({ seq: 1 }).lean();
  return events.map((e) => e.type);
}

describe('review processing', () => {
  let t: TestApp;
  let agent: Agent;
  let csrf: string;

  beforeAll(async () => {
    await connectTestDb();
    t = createTestApp();
  });
  beforeEach(async () => {
    await clearTestDb();
    t.llm.setHandler(undefined);
    t.llm.calls = [];
    agent = newAgent(t.app);
    csrf = (await registerUser(agent)).csrfToken;
  });
  afterAll(disconnectTestDb);

  it('runs the documented lifecycle and persists before publishing', async () => {
    const { reviewId } = await createReview(agent, csrf);
    const review = await processUntilSettled(t.container, reviewId);

    expect(review.status).toBe('completed');
    expect(review.startedAt).toBeInstanceOf(Date);
    // Only the documented fields: no categories (the service reviews every issue type).
    expect(t.llm.calls).toEqual([{ requestId: reviewId, content: SAMPLE_CONTENT }]);
    expect(await eventTypes(reviewId)).toEqual([
      'review.started',
      'review.progress',
      'review.progress',
      'review.progress',
      ...Array<string>(review.findingCount).fill('finding.detected'),
      'review.completed',
    ]);
    const job = await ReviewJobModel.findOne({ reviewId }).lean();
    expect(job).toMatchObject({ status: 'succeeded', attempts: 1, lockedBy: null });
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    t.llm.setHandler((req, call) => {
      if (call === 1) throw new LlmUnavailableError('down');
      if (call === 2) throw new LlmRateLimitedError('busy', { retryAfterMs: 30 });
      return [];
    });
    const { reviewId } = await createReview(agent, csrf);
    const review = await processUntilSettled(t.container, reviewId);

    expect(review.status).toBe('completed');
    expect(t.llm.calls).toHaveLength(3);
    const job = await ReviewJobModel.findOne({ reviewId }).lean();
    expect(job).toMatchObject({ status: 'succeeded', attempts: 3 });

    const progress = await ReviewEventModel.find({ reviewId, type: 'review.progress' })
      .sort({ seq: 1 })
      .lean();
    const stages = progress.map((e) => `${e.data.stage as string}:${e.data.attempt as number}`);
    expect(stages).toEqual([
      'analyzing:1',
      'retrying:1',
      'analyzing:2',
      'retrying:2',
      'analyzing:3',
      'validating:3',
      'persisting:3',
    ]);
    // review.started is emitted once even across attempts.
    expect((await eventTypes(reviewId)).filter((e) => e === 'review.started')).toHaveLength(1);
  });

  it('fails permanently after exhausting the retry budget', async () => {
    t.llm.setHandler(() => {
      throw new LlmUnavailableError('down');
    });
    const { reviewId } = await createReview(agent, csrf);
    const review = await processUntilSettled(t.container, reviewId);

    expect(review).toMatchObject({
      status: 'failed',
      errorCode: 'LLM_SERVICE_UNAVAILABLE',
      errorMessage: 'The review service is temporarily unavailable.',
    });
    expect(t.llm.calls).toHaveLength(3); // JOB_MAX_ATTEMPTS
    expect((await eventTypes(reviewId)).at(-1)).toBe('review.failed');
    expect(await ReviewJobModel.findOne({ reviewId }).lean()).toMatchObject({
      status: 'failed',
      lastErrorCode: 'LLM_SERVICE_UNAVAILABLE',
    });
  });

  it('passes the chosen model to the AI service', async () => {
    const { reviewId } = await createReview(agent, csrf, { model: 'mock-rules-v3' });
    const review = await processUntilSettled(t.container, reviewId);
    expect(review).toMatchObject({ status: 'completed', model: 'mock-rules-v3' });
    expect(t.llm.calls[0]).toMatchObject({ model: 'mock-rules-v3' });
  });

  it('fails fast on a daily quota and stores when it resets', async () => {
    const details = {
      model: 'mock-rules-v2',
      quotaScope: 'daily' as const,
      retryAfterSeconds: 7105,
      resetAt: '2026-10-11T05:30:00+00:00',
    };
    t.llm.setHandler(() => {
      throw new LlmRateLimitedError('429', {
        quota: details,
        upstreamMessage:
          'The daily quota for model mock-rules-v2 is exhausted. It resets in about 1h 58m.',
      });
    });
    const { reviewId } = await createReview(agent, csrf);
    const review = await processUntilSettled(t.container, reviewId);
    expect(review).toMatchObject({
      status: 'failed',
      errorCode: 'LLM_SERVICE_RATE_LIMITED',
      errorMessage: expect.stringContaining('1h 58m'),
      errorDetails: details,
    });
    expect(t.llm.calls).toHaveLength(1);
    const failed = await ReviewEventModel.findOne({ reviewId, type: 'review.failed' }).lean();
    expect(failed?.data).toMatchObject({ errorDetails: details });
  });

  it('does not retry non-retryable errors', async () => {
    t.llm.setHandler(() => {
      throw new LlmRejectedError('bad request', 400, 'INVALID_REQUEST');
    });
    const { reviewId } = await createReview(agent, csrf);
    const review = await processUntilSettled(t.container, reviewId);
    expect(review).toMatchObject({ status: 'failed', errorCode: 'LLM_REQUEST_REJECTED' });
    expect(t.llm.calls).toHaveLength(1);
  });

  it('retries invalid model output once', async () => {
    t.llm.setHandler(() => {
      throw new LlmBadResponseError('INVALID_MODEL_OUTPUT');
    });
    const { reviewId } = await createReview(agent, csrf);
    const review = await processUntilSettled(t.container, reviewId);
    expect(review).toMatchObject({ status: 'failed', errorCode: 'LLM_INVALID_RESPONSE' });
    expect(t.llm.calls).toHaveLength(2);
  });

  it('fails content that is too large without retrying', async () => {
    t.llm.setHandler(() => {
      throw new LlmContentTooLargeError('413');
    });
    const { reviewId } = await createReview(agent, csrf);
    const review = await processUntilSettled(t.container, reviewId);
    expect(review).toMatchObject({
      status: 'failed',
      errorCode: 'LLM_CONTENT_TOO_LARGE',
      errorMessage: 'The content is too long to review. Shorten it and try again.',
    });
    expect(t.llm.calls).toHaveLength(1);
  });

  it('places issues by their context, keeps every issue type, drops unplaceable ones', async () => {
    const content = 'Héllo 👋🏽 wrld! wrld?';
    // Code points: H é l l o ␠ 👋 🏽 ␠ w r l d ! ␠ w r l d ?  → second "wrld" is [15, 19)
    const wrld = {
      id: 'issue-1',
      issueType: 'typo' as const,
      severity: 'low' as const,
      original: 'wrld',
      improved: 'world',
      suggestion: 'Fix the typo.',
      location: { prefix: '! ', suffix: '?' },
    };
    t.llm.setHandler(() => [
      {
        ...wrld,
        id: 'issue-0',
        issueType: 'clarity',
        original: 'Héllo',
        improved: 'Hello',
        location: { prefix: '', suffix: ' 👋🏽' },
      },
      wrld,
      { ...wrld, id: 'issue-dup' },
      { ...wrld, id: 'issue-gone', original: 'nope', location: { prefix: '', suffix: '' } },
    ]);
    // `categories` is informational now; issues of other types are still kept.
    const { reviewId } = await createReview(agent, csrf, { content, categories: ['spelling'] });
    const review = await processUntilSettled(t.container, reviewId);

    expect(review.status).toBe('completed');
    expect(
      review.findings.map((f) => [f.category, f.originalText, f.startOffset, f.endOffset]),
    ).toEqual([
      ['clarity', 'Héllo', 0, 5],
      ['typo', 'wrld', 15, 19],
    ]);
    expect(review.findings[1]).toMatchObject({
      suggestedText: 'world',
      explanation: 'Fix the typo.',
    });
  });

  it('handles duplicate delivery without duplicating findings or events', async () => {
    const { reviewId } = await createReview(agent, csrf);
    await processUntilSettled(t.container, reviewId);
    const before = await ReviewEventModel.countDocuments({ reviewId });
    const findingsBefore = (await ReviewModel.findById(reviewId).lean())!.findings;

    // Simulate the queue re-delivering the job after completion.
    await ReviewJobModel.updateOne(
      { reviewId },
      { $set: { status: 'queued', runAfter: new Date() } },
    );
    await t.container.worker.drain();

    const after = await ReviewModel.findById(reviewId).lean();
    expect(after!.findings).toEqual(findingsBefore);
    expect(await ReviewEventModel.countDocuments({ reviewId })).toBe(before);
    expect(t.llm.calls).toHaveLength(1); // no second LLM call for a completed review
  });

  it('enqueueing the same review twice creates one job', async () => {
    const { reviewId } = await createReview(agent, csrf);
    expect(await t.container.jobQueue.enqueue(reviewId)).toBe(false);
    expect(await ReviewJobModel.countDocuments({ reviewId })).toBe(1);
  });

  it('re-claims a job whose worker crashed (expired lease)', async () => {
    const { reviewId } = await createReview(agent, csrf);
    // A crashed worker: job running, review processing, lease expired.
    await ReviewJobModel.updateOne(
      { reviewId },
      {
        $set: {
          status: 'running',
          lockedBy: 'dead-worker',
          lockedUntil: new Date(Date.now() - 1000),
          attempts: 1,
        },
      },
    );
    await ReviewModel.updateOne(
      { _id: reviewId },
      { $set: { status: 'processing', jobAttempt: 1 } },
    );

    const review = await processUntilSettled(t.container, reviewId);
    expect(review.status).toBe('completed');
    expect(await ReviewJobModel.findOne({ reviewId }).lean()).toMatchObject({
      status: 'succeeded',
      attempts: 2,
    });
  });

  it('does not let a stale worker overwrite a newer attempt', async () => {
    const { reviewId } = await createReview(agent, csrf);
    t.llm.setHandler(async () => {
      // While "attempt 1" is analyzing, another worker takes over as attempt 2.
      await ReviewModel.updateOne({ _id: reviewId }, { $set: { jobAttempt: 2 } });
      return [];
    });
    const job = await t.container.jobQueue.claim('worker-a');
    const outcome = await t.container.processor.process(
      job!,
      'worker-a',
      new AbortController().signal,
    );

    expect(outcome).toBe('skipped');
    const review = await ReviewModel.findById(reviewId).lean();
    expect(review!.status).toBe('processing');
    expect(await eventTypes(reviewId)).not.toContain('review.completed');
  });

  it('fails a job whose final attempt crashed', async () => {
    const { reviewId } = await createReview(agent, csrf);
    await ReviewJobModel.updateOne(
      { reviewId },
      {
        $set: {
          status: 'running',
          lockedBy: 'dead',
          lockedUntil: new Date(Date.now() - 1000),
          attempts: 3,
        },
      },
    );
    await ReviewModel.updateOne(
      { _id: reviewId },
      { $set: { status: 'processing', jobAttempt: 3 } },
    );
    const review = await processUntilSettled(t.container, reviewId);
    expect(review).toMatchObject({ status: 'failed', errorCode: 'PROCESSING_TIMEOUT' });
    expect(t.llm.calls).toHaveLength(0);
  });

  it('releases in-flight jobs on shutdown without consuming an attempt', async () => {
    // A second app instance whose (mock) LLM call outlives the shutdown grace period.
    const slow = createTestApp({ llmClient: new MockPythonLlmClient({ delayMs: 5_000 }) });
    const { reviewId } = await createReview(agent, csrf);

    slow.container.worker.start();
    await waitFor(
      async () => (await ReviewModel.findById(reviewId).lean())?.status === 'processing',
    );
    await slow.container.worker.stop(50);

    const job = await ReviewJobModel.findOne({ reviewId }).lean();
    expect(job).toMatchObject({ status: 'queued', attempts: 0, lockedBy: null });

    // Another worker picks it up and completes it.
    expect((await processUntilSettled(t.container, reviewId)).status).toBe('completed');
  });

  describe('recovery sweep', () => {
    it('re-enqueues a stale review that has no job', async () => {
      const { reviewId } = await createReview(agent, csrf);
      await ReviewJobModel.deleteMany({ reviewId });
      await ReviewModel.collection.updateOne(
        { _id: (await ReviewModel.findById(reviewId))!._id },
        { $set: { updatedAt: new Date(Date.now() - 10 * 60_000) } },
      );

      const result = await t.container.recovery.recoverOrphans();
      expect(result).toEqual({ requeued: 1, failed: 0 });
      expect((await processUntilSettled(t.container, reviewId)).status).toBe('completed');
    });

    it('fails a stale processing review whose job already finished', async () => {
      const { reviewId } = await createReview(agent, csrf);
      const doc = (await ReviewModel.findById(reviewId))!;
      await ReviewJobModel.updateOne({ reviewId }, { $set: { status: 'succeeded' } });
      await ReviewModel.collection.updateOne(
        { _id: doc._id },
        { $set: { status: 'processing', updatedAt: new Date(Date.now() - 10 * 60_000) } },
      );

      expect(await t.container.recovery.recoverOrphans()).toEqual({ requeued: 0, failed: 1 });
      const review = await ReviewModel.findById(reviewId).lean();
      expect(review).toMatchObject({ status: 'failed', errorCode: 'PROCESSING_TIMEOUT' });
      expect((await eventTypes(reviewId)).at(-1)).toBe('review.failed');
    });

    it('leaves fresh and actively running reviews alone', async () => {
      await createReview(agent, csrf);
      expect(await t.container.recovery.recoverOrphans()).toEqual({ requeued: 0, failed: 0 });
    });
  });

  it('stops processing when the review is deleted mid-flight', async () => {
    const { reviewId } = await createReview(agent, csrf);
    t.llm.setHandler(async () => {
      await agent.delete(`/api/v1/reviews/${reviewId}`).set('X-CSRF-Token', csrf).expect(204);
      return [];
    });
    await t.container.worker.drain();
    expect(await ReviewModel.countDocuments({ _id: reviewId })).toBe(0);
    expect(await ReviewEventModel.countDocuments({ reviewId })).toBe(0);
  });

  describe('per-error retry limits', () => {
    let roomy: TestApp;
    let roomyAgent: Agent;
    let roomyCsrf: string;
    beforeAll(() => {
      // A larger job budget so the error-specific limits are what stop the retries.
      roomy = createTestApp({ env: { JOB_MAX_ATTEMPTS: '6' } });
    });
    beforeEach(async () => {
      roomy.llm.calls = [];
      // Reviews must be created through this app so their jobs get its attempt budget.
      roomyAgent = newAgent(roomy.app);
      roomyCsrf = (await registerUser(roomyAgent)).csrfToken;
    });

    it.each([
      ['503 retries at most twice', () => new LlmUnavailableError('503', { maxRetries: 2 }), 3],
      ['invalid model output retries once', () => new LlmBadResponseError('502'), 2],
      ['transport failures use the full job budget', () => new LlmUnavailableError('down'), 6],
      ['quota exhaustion uses the full job budget', () => new LlmRateLimitedError('429'), 6],
    ])('%s', async (_name, makeError, expectedCalls) => {
      roomy.llm.setHandler(() => {
        throw makeError();
      });
      const { reviewId } = await createReview(roomyAgent, roomyCsrf);
      const review = await processUntilSettled(roomy.container, reviewId);
      expect(review.status).toBe('failed');
      expect(roomy.llm.calls).toHaveLength(expectedCalls);
    });
  });

  describe('against the Python HTTP API', () => {
    let server: http.Server;
    let httpApp: TestApp;
    let llm: HttpPythonLlmClient;
    let respond: (body: { requestId: string; content: string }, call: number) => [number, unknown];
    let bodies: string[] = [];

    beforeAll(async () => {
      server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          bodies.push(body);
          const [status, payload] = respond(JSON.parse(body), bodies.length);
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(payload));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      llm = new HttpPythonLlmClient({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        serviceToken: 'service-token-0123456789',
        timeoutMs: 2_000,
        connectTimeoutMs: 500,
        logger: pino({ level: 'silent' }),
      });
      httpApp = createTestApp({ llmClient: llm });
    });
    beforeEach(() => {
      bodies = [];
    });
    afterAll(async () => {
      await llm.close();
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });

    it('turns Python issues into findings the UI can highlight', async () => {
      respond = (body) => [
        200,
        {
          requestId: body.requestId,
          issues: [
            {
              id: 'issue-3f9a1c2b7d10',
              issueType: 'spelling',
              severity: 'low',
              original: 'recieve',
              improved: 'receive',
              suggestion: 'Correct the spelling mistake.',
              location: { prefix: 'Please ', suffix: ' teh files' },
            },
          ],
          model: 'gemini-test',
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      ];
      const { reviewId } = await createReview(agent, csrf);
      const review = await processUntilSettled(httpApp.container, reviewId);

      expect(JSON.parse(bodies[0]!)).toEqual({ requestId: reviewId, content: SAMPLE_CONTENT });
      expect(review.status).toBe('completed');
      const start = SAMPLE_CONTENT.indexOf('recieve');
      expect(review.findings).toEqual([
        expect.objectContaining({
          category: 'spelling',
          originalText: 'recieve',
          suggestedText: 'receive',
          explanation: 'Correct the spelling mistake.',
          startOffset: start,
          endOffset: start + 'recieve'.length,
        }),
      ]);
    });

    it('completes with no findings when there are no issues', async () => {
      respond = (body) => [
        200,
        {
          requestId: body.requestId,
          issues: [],
          model: 'm',
          usage: { inputTokens: null, outputTokens: null },
        },
      ];
      const { reviewId } = await createReview(agent, csrf);
      const review = await processUntilSettled(httpApp.container, reviewId);
      expect(review).toMatchObject({ status: 'completed', findingCount: 0, findings: [] });
    });

    it('retries a 503 and succeeds', async () => {
      respond = (body, call) =>
        call === 1
          ? [
              503,
              {
                error: { code: 'AI_CONCURRENCY_LIMIT', message: 'busy', requestId: body.requestId },
              },
            ]
          : [
              200,
              {
                requestId: body.requestId,
                issues: [],
                model: 'm',
                usage: { inputTokens: null, outputTokens: null },
              },
            ];
      const { reviewId } = await createReview(agent, csrf);
      const review = await processUntilSettled(httpApp.container, reviewId);
      expect(review.status).toBe('completed');
      expect(bodies).toHaveLength(2);
    });

    it.each([
      [401, 'UNAUTHORIZED', 'LLM_REQUEST_REJECTED'],
      [422, 'INVALID_REQUEST', 'LLM_REQUEST_REJECTED'],
      [413, 'CONTENT_TOO_LARGE', 'LLM_CONTENT_TOO_LARGE'],
    ])('fails without retrying on %i %s', async (status, code, errorCode) => {
      respond = (body) => [status, { error: { code, message: 'x', requestId: body.requestId } }];
      const { reviewId } = await createReview(agent, csrf);
      const review = await processUntilSettled(httpApp.container, reviewId);
      expect(review).toMatchObject({ status: 'failed', errorCode });
      expect(bodies).toHaveLength(1);
    });
  });
});
