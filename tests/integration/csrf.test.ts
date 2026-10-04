import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  clearTestDb,
  connectTestDb,
  createTestApp,
  disconnectTestDb,
  fetchCsrf,
  newAgent,
  PASSWORD,
  registerUser,
  type TestApp,
} from '../helpers/test-app.js';

const reviewBody = { documentTitle: 'Doc', content: 'Hello world', categories: ['grammar'] };

describe('CSRF and origin protection', () => {
  let t: TestApp;

  beforeAll(async () => {
    await connectTestDb();
    t = createTestApp();
  });
  beforeEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('issues a token and sets HttpOnly CSRF + anonymous cookies', async () => {
    const res = await newAgent(t.app).get('/api/v1/auth/csrf').expect(200);
    expect(res.body.csrfToken).toEqual(expect.any(String));
    expect(res.headers['cache-control']).toBe('no-store');
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/content_review_csrf=.*HttpOnly/i);
    expect(cookies).toMatch(/content_review_session_anon=.*HttpOnly/i);
  });

  it('rejects state-changing requests without a token', async () => {
    const agent = newAgent(t.app);
    await fetchCsrf(agent);
    const res = await agent
      .post('/api/v1/auth/register')
      .send({ email: 'a@example.com', password: PASSWORD, displayName: 'A' })
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it('rejects an invalid token', async () => {
    const agent = newAgent(t.app);
    await fetchCsrf(agent);
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', 'forged-token')
      .send({ email: 'a@example.com', password: PASSWORD, displayName: 'A' })
      .expect(403);
    expect(res.body.error.code).toBe('CSRF_INVALID');
  });

  it("rejects a token minted for another browser (attacker's own token)", async () => {
    const attacker = newAgent(t.app);
    const attackerToken = await fetchCsrf(attacker);
    const victim = newAgent(t.app);
    await fetchCsrf(victim);
    await victim
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', attackerToken)
      .send({ email: 'a@example.com', password: PASSWORD, displayName: 'A' })
      .expect(403);
  });

  it('binds tokens to the session: the pre-login token stops working after login', async () => {
    const agent = newAgent(t.app);
    const preLogin = await fetchCsrf(agent);
    const reg = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', preLogin)
      .send({ email: 'b@example.com', password: PASSWORD, displayName: 'B' })
      .expect(201);

    await agent.post('/api/v1/reviews').set('X-CSRF-Token', preLogin).send(reviewBody).expect(403);
    await agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', reg.body.csrfToken)
      .send(reviewBody)
      .expect(202);

    // GET /csrf after login returns a token valid for the session.
    const fresh = await fetchCsrf(agent);
    await agent.post('/api/v1/reviews').set('X-CSRF-Token', fresh).send(reviewBody).expect(202);
  });

  it('does not require CSRF tokens for safe methods', async () => {
    const agent = newAgent(t.app);
    await registerUser(agent);
    await agent.get('/api/v1/reviews').expect(200);
  });

  it('rejects disallowed origins on state-changing requests', async () => {
    const agent = newAgent(t.app);
    const { csrfToken } = await registerUser(agent);
    const res = await agent
      .post('/api/v1/reviews')
      .set('Origin', 'https://evil.example')
      .set('X-CSRF-Token', csrfToken)
      .send(reviewBody)
      .expect(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('falls back to Referer when Origin is absent', async () => {
    const res = await supertest(t.app)
      .post('/api/v1/auth/login')
      .set('Referer', 'https://evil.example/page')
      .send({ email: 'a@example.com', password: 'x' })
      .expect(403);
    expect(res.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
  });

  it('answers CORS preflight only for allow-listed origins', async () => {
    const ok = await supertest(t.app)
      .options('/api/v1/reviews')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'content-type,x-csrf-token');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');

    const bad = await supertest(t.app)
      .options('/api/v1/reviews')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'POST');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sets security headers', async () => {
    const res = await supertest(t.app).get('/health/live').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-request-id']).toEqual(expect.any(String));
  });
});
