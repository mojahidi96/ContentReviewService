import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LlmRejectedError } from '../../src/integrations/python-llm/llm.errors.js';
import { ReviewModel } from '../../src/modules/reviews/review.model.js';
import {
  clearTestDb,
  connectTestDb,
  createReview,
  createTestApp,
  disconnectTestDb,
  newAgent,
  parseSse,
  processUntilSettled,
  registerUser,
  sseParser,
  type Agent,
  type TestApp,
} from '../helpers/test-app.js';

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('review SSE stream', () => {
  let t: TestApp;
  let agent: Agent;
  let csrf: string;

  const stream = (url: string, headers: Record<string, string> = {}) =>
    agent.get(url).set(headers).buffer(true).parse(sseParser);

  beforeAll(async () => {
    await connectTestDb();
    t = createTestApp();
  });
  beforeEach(async () => {
    await clearTestDb();
    t.llm.setHandler(undefined);
    agent = newAgent(t.app);
    csrf = (await registerUser(agent)).csrfToken;
  });
  afterAll(disconnectTestDb);

  it('streams live progress and findings in order, then closes after review.completed', async () => {
    const { reviewId, eventsUrl } = await createReview(agent, csrf);
    const pending = stream(eventsUrl).then((r) => r);
    await waitFor(() => t.container.sseRegistry.size === 1);

    await t.container.worker.drain();
    const res = await pending;

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.headers['x-accel-buffering']).toBe('no');

    const { events, retry } = parseSse(res.body as string);
    expect(retry).toBe(3000);
    const types = events.map((e) => e.event);
    expect(types[0]).toBe('review.started');
    expect(types.at(-1)).toBe('review.completed');
    expect(types.filter((x) => x === 'finding.detected')).toHaveLength(5);

    // Ids are strictly increasing integers.
    const ids = events.map((e) => e.id!);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);

    for (const e of events)
      expect(e.data).toMatchObject({ reviewId, occurredAt: expect.any(String) });
    const completed = events.at(-1)!.data;
    expect(completed).toMatchObject({ status: 'completed', findingCount: 5 });

    // Persisted state matches what was streamed.
    const review = await ReviewModel.findById(reviewId).lean();
    const streamedIds = events
      .filter((e) => e.event === 'finding.detected')
      .map((e) => e.data.finding.findingId);
    expect(streamedIds.sort()).toEqual(review!.findings.map((f) => f.findingId).sort());

    await waitFor(() => t.container.sseRegistry.size === 0);
  });

  it('replays persisted events for a client that connects after completion', async () => {
    const { reviewId, eventsUrl } = await createReview(agent, csrf);
    await processUntilSettled(t.container, reviewId);

    const res = await stream(eventsUrl).expect(200);
    const { events } = parseSse(res.body as string);
    expect(events[0]!.event).toBe('review.started');
    expect(events.at(-1)!.event).toBe('review.completed');
  });

  it('resumes after Last-Event-ID without repeating delivered events', async () => {
    const { reviewId, eventsUrl } = await createReview(agent, csrf);
    await processUntilSettled(t.container, reviewId);
    const all = parseSse((await stream(eventsUrl)).body as string).events;
    const cut = all[4]!.id!;

    const resumed = parseSse(
      (await stream(eventsUrl, { 'Last-Event-ID': String(cut) })).body as string,
    ).events;
    expect(resumed.map((e) => e.id)).toEqual(all.filter((e) => e.id! > cut).map((e) => e.id));

    // Query parameter works too (for a fresh EventSource after a page reload).
    const viaQuery = parseSse(
      (await stream(`${eventsUrl}?lastEventId=${cut}`)).body as string,
    ).events;
    expect(viaQuery.map((e) => e.id)).toEqual(resumed.map((e) => e.id));
  });

  it('answers 204 when a terminal review has nothing left to deliver (stops EventSource retries)', async () => {
    const { reviewId, eventsUrl } = await createReview(agent, csrf);
    await processUntilSettled(t.container, reviewId);
    const all = parseSse((await stream(eventsUrl)).body as string).events;
    await stream(eventsUrl, { 'Last-Event-ID': String(all.at(-1)!.id) }).expect(204);
  });

  it('streams review.failed for failed reviews', async () => {
    t.llm.setHandler(() => {
      throw new LlmRejectedError('nope', 400);
    });
    const { reviewId, eventsUrl } = await createReview(agent, csrf);
    await processUntilSettled(t.container, reviewId);

    const { events } = parseSse((await stream(eventsUrl)).body as string);
    expect(events.at(-1)).toMatchObject({
      event: 'review.failed',
      data: {
        reviewId,
        status: 'failed',
        errorCode: 'LLM_REQUEST_REJECTED',
        errorMessage: expect.any(String),
      },
    });
  });

  it('sends heartbeats and cleans up listeners when the client disconnects', async () => {
    const hb = createTestApp({ env: { SSE_HEARTBEAT_MS: '1000' } });
    const server = http.createServer(hb.app).listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as AddressInfo).port;

    const local = newAgent(hb.app);
    const localCsrf = (await registerUser(local)).csrfToken;
    const { eventsUrl } = await createReview(local, localCsrf);
    // Reuse the agent's session cookie for a raw request we can abort mid-stream.
    const cookies = (
      local as unknown as { jar: { getCookies: (o: object) => { toValueString(): string }[] } }
    ).jar
      .getCookies({ domain: '127.0.0.1', path: '/api', secure: false, script: false })
      .map((c) => c.toValueString())
      .join('; ');

    const baseline = hb.container.bus.listenerCount();
    let received = '';
    const req = http.get({ port, path: eventsUrl, headers: { Cookie: cookies } });
    const res = await new Promise<http.IncomingMessage>((resolve) => req.once('response', resolve));
    expect(res.statusCode).toBe(200);
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => (received += chunk));

    await waitFor(() => received.includes(': heartbeat'), 3_000);
    expect(hb.container.sseRegistry.size).toBe(1);
    expect(hb.container.bus.listenerCount()).toBe(baseline + 1);

    req.destroy();
    await waitFor(() => hb.container.sseRegistry.size === 0);
    expect(hb.container.bus.listenerCount()).toBe(baseline);
    await new Promise((r) => server.close(r));
  });

  it('closes the stream if the review is deleted while connected', async () => {
    const { reviewId, eventsUrl } = await createReview(agent, csrf);
    const pending = stream(eventsUrl).then((r) => r);
    await waitFor(() => t.container.sseRegistry.size === 1);
    await ReviewModel.deleteOne({ _id: reviewId });
    const res = await pending;
    expect(res.status).toBe(200);
    await waitFor(() => t.container.sseRegistry.size === 0);
  });

  it('rejects unauthenticated and foreign subscriptions before opening the stream', async () => {
    const { eventsUrl } = await createReview(agent, csrf);
    const anon = await newAgent(t.app).get(eventsUrl).expect(401);
    expect(anon.headers['content-type']).toMatch(/application\/json/);

    const other = newAgent(t.app);
    await registerUser(other);
    await other.get(eventsUrl).expect(404);
    await agent.get(`${eventsUrl}?lastEventId=-1`).expect(400);
  });
});
