import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReviewJobModel } from '../../src/infrastructure/jobs/job.model.js';
import {
  LlmBadResponseError,
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
    expect(t.llm.calls).toEqual([
      expect.objectContaining({
        requestId: reviewId,
        language: 'en',
        categories: ['grammar', 'spelling', 'profanity'],
      }),
    ]);
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

  it('does not retry non-retryable errors', async () => {
    t.llm.setHandler(() => {
      throw new LlmRejectedError('bad request', 400, 'INVALID_REQUEST');
    });
    const { reviewId } = await createReview(agent, csrf);
    const review = await processUntilSettled(t.container, reviewId);
    expect(review).toMatchObject({ status: 'failed', errorCode: 'LLM_REQUEST_REJECTED' });
    expect(t.llm.calls).toHaveLength(1);
  });

  it('treats malformed responses as retryable but bounded', async () => {
    t.llm.setHandler(() => {
      throw new LlmBadResponseError('schema');
    });
    const { reviewId } = await createReview(agent, csrf);
    const review = await processUntilSettled(t.container, reviewId);
    expect(review).toMatchObject({ status: 'failed', errorCode: 'LLM_INVALID_RESPONSE' });
    expect(t.llm.calls).toHaveLength(3);
  });

  it('drops findings with mismatched offsets, unrequested categories and duplicates', async () => {
    const content = 'Héllo 👋🏽 wrld!';
    // Code points: H é l l o ␠ 👋 🏽 ␠ w r l d !  → "wrld" is [9, 13)
    t.llm.setHandler(() => [
      {
        category: 'spelling',
        severity: 'low',
        originalText: 'wrld',
        suggestedText: 'world',
        explanation: 'Typo.',
        startOffset: 9,
        endOffset: 13,
      },
      {
        category: 'spelling',
        severity: 'low',
        originalText: 'wrld',
        suggestedText: 'world',
        explanation: 'Typo.',
        startOffset: 9,
        endOffset: 13,
      },
      // UTF-16 offsets (wrong convention) must be rejected.
      {
        category: 'spelling',
        severity: 'low',
        originalText: 'wrld',
        suggestedText: 'world',
        explanation: 'Typo.',
        startOffset: 11,
        endOffset: 15,
      },
      {
        category: 'grammar',
        severity: 'low',
        originalText: 'Héllo',
        suggestedText: 'Hello',
        explanation: 'x',
        startOffset: 0,
        endOffset: 5,
      },
      {
        category: 'spelling',
        severity: 'low',
        originalText: 'nope',
        suggestedText: '',
        explanation: 'x',
        startOffset: 50,
        endOffset: 54,
      },
    ]);
    const { reviewId } = await createReview(agent, csrf, { content, categories: ['spelling'] });
    const review = await processUntilSettled(t.container, reviewId);

    expect(review.status).toBe('completed');
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({
      originalText: 'wrld',
      startOffset: 9,
      endOffset: 13,
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
});
