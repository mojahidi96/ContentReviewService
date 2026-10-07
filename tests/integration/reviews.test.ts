import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ReviewJobModel } from '../../src/infrastructure/jobs/job.model.js';
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

describe('review API', () => {
  let t: TestApp;
  let alice: Agent;
  let aliceCsrf: string;

  beforeAll(async () => {
    await connectTestDb();
    t = createTestApp({ env: { REVIEW_MAX_CONTENT_CHARS: '100' } });
  });
  beforeEach(async () => {
    await clearTestDb();
    t.llm.setHandler(undefined);
    alice = newAgent(t.app);
    aliceCsrf = (await registerUser(alice)).csrfToken;
  });
  afterAll(disconnectTestDb);

  it('requires authentication on every review endpoint', async () => {
    const anon = newAgent(t.app);
    const id = '0123456789abcdef01234567';
    for (const path of [
      '/api/v1/reviews',
      `/api/v1/reviews/${id}`,
      `/api/v1/reviews/${id}/events`,
    ]) {
      const res = await anon.get(path).expect(401);
      expect(res.body.error.code).toBe('AUTH_REQUIRED');
    }
  });

  it('creates a review and returns 202 without waiting for analysis', async () => {
    const res = await alice
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', aliceCsrf)
      .send({
        documentTitle: '  Quarterly Report  ',
        content: SAMPLE_CONTENT,
        categories: ['grammar'],
      })
      .expect(202);

    expect(res.body).toEqual({
      reviewId: expect.stringMatching(/^[a-f0-9]{24}$/),
      status: 'pending',
      eventsUrl: `/api/v1/reviews/${res.body.reviewId}/events`,
      createdAt: expect.any(String),
    });
    expect(res.headers.location).toBe(`/api/v1/reviews/${res.body.reviewId}`);
    expect(t.llm.calls).toHaveLength(0); // analysis happens asynchronously

    const stored = await ReviewModel.findById(res.body.reviewId).lean();
    expect(stored).toMatchObject({
      documentTitle: 'Quarterly Report',
      status: 'pending',
      contentLength: 67,
    });
    expect(stored?.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.expiresAt).toBeInstanceOf(Date);
    expect(await ReviewJobModel.countDocuments({ reviewId: res.body.reviewId })).toBe(1);
  });

  it.each([
    [{ documentTitle: '', content: 'x', categories: ['grammar'] }, 'body.documentTitle'],
    [{ documentTitle: 'T', content: '   ', categories: ['grammar'] }, 'body.content'],
    [{ documentTitle: 'T', content: 'x', categories: [] }, 'body.categories'],
    [{ documentTitle: 'T', content: 'x', categories: ['grammar', 'grammar'] }, 'body.categories'],
    [{ documentTitle: 'T', content: 'x', categories: ['style'] }, 'body.categories.0'],
    [{ documentTitle: 'T', content: 'x'.repeat(101), categories: ['grammar'] }, 'body.content'],
    [{ documentTitle: 'T', content: 'x', categories: ['grammar'], userId: 'abc' }, 'body'],
  ])('rejects invalid input %#', async (body, path) => {
    const res = await alice
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', aliceCsrf)
      .send(body)
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect((res.body.error.details as { path: string }[]).map((d) => d.path)).toContain(path);
  });

  it('measures the content limit in code points, not UTF-16 units', async () => {
    // 100 emoji = 100 code points = 200 UTF-16 units: allowed at a 100-char limit.
    await alice
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', aliceCsrf)
      .send({ documentTitle: 'Emoji', content: '😀'.repeat(100), categories: ['spelling'] })
      .expect(202);
  });

  it('accepts a review without categories (the service checks every issue type)', async () => {
    const res = await alice
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', aliceCsrf)
      .send({ documentTitle: 'No categories', content: 'Please recieve it.' })
      .expect(202);
    const detail = await alice.get(`/api/v1/reviews/${res.body.reviewId as string}`).expect(200);
    expect(detail.body.review.categories).toEqual([]);
  });

  it('rejects oversized bodies with 413', async () => {
    const big = createTestApp({ env: { BODY_LIMIT: '1kb' } });
    const agent = newAgent(big.app);
    const { csrfToken } = await registerUser(agent);
    const res = await agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', csrfToken)
      .send({ documentTitle: 'Big', content: 'x'.repeat(5000), categories: ['grammar'] })
      .expect(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('processes a review and returns persisted findings', async () => {
    const { reviewId } = await createReview(alice, aliceCsrf);
    await processUntilSettled(t.container, reviewId);

    const res = await alice.get(`/api/v1/reviews/${reviewId}`).expect(200);
    const review = res.body.review;
    expect(review).toMatchObject({
      reviewId,
      status: 'completed',
      content: SAMPLE_CONTENT,
      findingCount: 5,
      errorCode: null,
      eventsUrl: `/api/v1/reviews/${reviewId}/events`,
    });
    expect(review.completedAt).toEqual(expect.any(String));
    for (const f of review.findings) {
      expect(f.findingId).toMatch(/^fnd_[a-f0-9]{24}$/);
      expect(f.status).toBe('pending');
      expect(Array.from(SAMPLE_CONTENT).slice(f.startOffset, f.endOffset).join('')).toBe(
        f.originalText,
      );
    }
    expect(review.findings.map((f: { category: string }) => f.category).sort()).toEqual([
      'grammar',
      'grammar',
      'spelling',
      'spelling',
      'vulgarity',
    ]);
  });

  it('lists only the caller’s reviews, newest first, with pagination and status filter', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++)
      ids.push((await createReview(alice, aliceCsrf, { documentTitle: `Doc ${i}` })).reviewId);
    const pending = await alice.get('/api/v1/reviews?status=pending').expect(200);
    expect(pending.body.total).toBe(3);
    await processUntilSettled(t.container, ids[0]!); // drains all queued jobs

    const bob = newAgent(t.app);
    const bobCsrf = (await registerUser(bob)).csrfToken;
    await createReview(bob, bobCsrf);

    const page1 = await alice.get('/api/v1/reviews?limit=2').expect(200);
    expect(page1.body).toMatchObject({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(page1.body.items.map((r: { documentTitle: string }) => r.documentTitle)).toEqual([
      'Doc 2',
      'Doc 1',
    ]);
    expect(page1.body.items[0].content).toBeUndefined();
    expect(page1.body.items[0].findings).toBeUndefined();

    const page2 = await alice.get('/api/v1/reviews?limit=2&page=2').expect(200);
    expect(page2.body.items.map((r: { documentTitle: string }) => r.documentTitle)).toEqual([
      'Doc 0',
    ]);

    const completed = await alice.get('/api/v1/reviews?status=completed').expect(200);
    expect(completed.body.total).toBe(3);
    expect(completed.body.items[0]).toMatchObject({ reviewId: ids[2], findingCount: 5 });
    const failed = await alice.get('/api/v1/reviews?status=failed').expect(200);
    expect(failed.body).toMatchObject({ total: 0, items: [] });

    await alice.get('/api/v1/reviews?status=bogus').expect(400);
    await alice.get('/api/v1/reviews?limit=500').expect(400);
  });

  it('enforces ownership: another user gets 404 for get, events, patch and delete', async () => {
    const { reviewId } = await createReview(alice, aliceCsrf);
    const review = await processUntilSettled(t.container, reviewId);
    const findingId = review.findings[0]!.findingId;

    const mallory = newAgent(t.app);
    const malloryCsrf = (await registerUser(mallory)).csrfToken;

    await mallory.get(`/api/v1/reviews/${reviewId}`).expect(404);
    await mallory.get(`/api/v1/reviews/${reviewId}/events`).expect(404);
    const patch = await mallory
      .patch(`/api/v1/reviews/${reviewId}/findings/${findingId}`)
      .set('X-CSRF-Token', malloryCsrf)
      .send({ status: 'accepted' })
      .expect(404);
    expect(patch.body.error.code).toBe('REVIEW_NOT_FOUND');
    await mallory
      .delete(`/api/v1/reviews/${reviewId}`)
      .set('X-CSRF-Token', malloryCsrf)
      .expect(404);

    const after = await ReviewModel.findById(reviewId).lean();
    expect(after?.findings[0]?.status).toBe('pending');
  });

  it('returns 400 for malformed ids and 404 for unknown reviews', async () => {
    await alice.get('/api/v1/reviews/not-an-id').expect(400);
    const res = await alice.get('/api/v1/reviews/0123456789abcdef01234567').expect(404);
    expect(res.body.error.code).toBe('REVIEW_NOT_FOUND');
  });

  describe('finding updates', () => {
    let reviewId: string;
    let findingId: string;

    beforeEach(async () => {
      reviewId = (await createReview(alice, aliceCsrf)).reviewId;
      const review = await processUntilSettled(t.container, reviewId);
      findingId = review.findings[0]!.findingId;
    });

    const patch = (status: string, id = findingId) =>
      alice
        .patch(`/api/v1/reviews/${reviewId}/findings/${id}`)
        .set('X-CSRF-Token', aliceCsrf)
        .send({ status });

    it('accepts, dismisses and re-accepts a finding', async () => {
      const accepted = await patch('accepted').expect(200);
      expect(accepted.body.finding).toMatchObject({ findingId, status: 'accepted' });

      const dismissed = await patch('dismissed').expect(200);
      expect(dismissed.body.finding.status).toBe('dismissed');

      await patch('accepted').expect(200);
      const stored = await ReviewModel.findById(reviewId).lean();
      expect(stored?.findings.find((f) => f.findingId === findingId)?.status).toBe('accepted');
    });

    it('is idempotent for repeated identical updates', async () => {
      await patch('dismissed').expect(200);
      const again = await patch('dismissed').expect(200);
      expect(again.body.finding.status).toBe('dismissed');
    });

    it('rejects statuses users may not set', async () => {
      for (const status of ['resolved', 'pending', 'bogus']) {
        const res = await patch(status).expect(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('rejects transitions out of resolved', async () => {
      await ReviewModel.updateOne(
        { _id: reviewId, 'findings.findingId': findingId },
        { $set: { 'findings.$.status': 'resolved' } },
      );
      const res = await patch('accepted').expect(409);
      expect(res.body.error.code).toBe('INVALID_STATE_TRANSITION');
    });

    it('returns 404 for unknown findings', async () => {
      const res = await patch('accepted', 'fnd_000000000000000000000000').expect(404);
      expect(res.body.error.code).toBe('FINDING_NOT_FOUND');
    });

    it('requires CSRF', async () => {
      await alice
        .patch(`/api/v1/reviews/${reviewId}/findings/${findingId}`)
        .send({ status: 'accepted' })
        .expect(403);
    });
  });

  it('refuses finding updates before the review completes', async () => {
    const { reviewId } = await createReview(alice, aliceCsrf);
    const res = await alice
      .patch(`/api/v1/reviews/${reviewId}/findings/fnd_000000000000000000000000`)
      .set('X-CSRF-Token', aliceCsrf)
      .send({ status: 'accepted' })
      .expect(409);
    expect(res.body.error.code).toBe('REVIEW_NOT_COMPLETED');
  });

  it('deletes a review with its events and job', async () => {
    const { reviewId } = await createReview(alice, aliceCsrf);
    await processUntilSettled(t.container, reviewId);
    expect(await ReviewEventModel.countDocuments({ reviewId })).toBeGreaterThan(0);

    await alice.delete(`/api/v1/reviews/${reviewId}`).set('X-CSRF-Token', aliceCsrf).expect(204);
    expect(await ReviewModel.countDocuments({ _id: reviewId })).toBe(0);
    expect(await ReviewEventModel.countDocuments({ reviewId })).toBe(0);
    expect(await ReviewJobModel.countDocuments({ reviewId })).toBe(0);
    await alice.get(`/api/v1/reviews/${reviewId}`).expect(404);
  });
});
