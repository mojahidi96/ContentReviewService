import supertest from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import {
  clearTestDb,
  connectTestDb,
  createTestApp,
  disconnectTestDb,
  fetchCsrf,
  newAgent,
  ORIGIN,
  PASSWORD,
  registerUser,
  type TestApp,
} from '../helpers/test-app.js';

function cookieHeader(res: supertest.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  return raw?.find((c) => c.startsWith(`${name}=`));
}

describe('auth flow', () => {
  let t: TestApp;

  beforeAll(async () => {
    await connectTestDb();
    t = createTestApp();
  });
  beforeEach(clearTestDb);
  afterAll(disconnectTestDb);

  it('registers, reads the current user, logs out and rejects the revoked session', async () => {
    const agent = newAgent(t.app);
    const csrf = await fetchCsrf(agent);

    const reg = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrf)
      .send({ email: '  Alice@Example.COM ', password: PASSWORD, displayName: 'Alice' })
      .expect(201);

    expect(reg.body.user).toMatchObject({ email: 'alice@example.com', displayName: 'Alice' });
    expect(reg.body.user.id).toMatch(/^[a-f0-9]{24}$/);
    expect(reg.body.csrfToken).toEqual(expect.any(String));
    // The JWT is never exposed to JavaScript.
    expect(JSON.stringify(reg.body)).not.toMatch(/eyJ/);
    expect(reg.body.user.passwordHash).toBeUndefined();

    const session = cookieHeader(reg, 'content_review_session');
    expect(session).toBeDefined();
    expect(session).toMatch(/HttpOnly/i);
    expect(session).toMatch(/Path=\/api/);
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Max-Age=900/);
    expect(session).not.toMatch(/Secure/i);

    const me = await agent.get('/api/v1/auth/me').expect(200);
    expect(me.body.user.email).toBe('alice@example.com');

    const rawCookie = session!.split(';')[0]!;
    await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', reg.body.csrfToken).expect(204);
    expect(await SessionModel.countDocuments()).toBe(0);

    // Replaying the old cookie after logout is rejected: logout revokes server-side.
    await supertest(t.app).get('/api/v1/auth/me').set('Cookie', rawCookie).expect(401);
    await agent.get('/api/v1/auth/me').expect(401);
  });

  it('logs in with valid credentials', async () => {
    const { email } = await registerUser(newAgent(t.app));
    const agent = newAgent(t.app);
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', csrf)
      .send({ email: email.toUpperCase(), password: PASSWORD })
      .expect(200);
    expect(res.body.user.email).toBe(email);
    expect(cookieHeader(res, 'content_review_session')).toBeDefined();
    await agent.get('/api/v1/auth/me').expect(200);
  });

  it('returns the same generic error for unknown emails and wrong passwords', async () => {
    const { email } = await registerUser(newAgent(t.app));
    const agent = newAgent(t.app);
    const csrf = await fetchCsrf(agent);

    const wrongPassword = await agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', csrf)
      .send({ email, password: 'not-the-password' })
      .expect(401);
    const unknownEmail = await agent
      .post('/api/v1/auth/login')
      .set('X-CSRF-Token', csrf)
      .send({ email: 'nobody@example.com', password: 'not-the-password' })
      .expect(401);

    expect(wrongPassword.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(unknownEmail.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPassword.body.error.message).toBe(unknownEmail.body.error.message);
  });

  it('rejects duplicate emails (case-insensitive)', async () => {
    await registerUser(newAgent(t.app), { email: 'dup@example.com' });
    const agent = newAgent(t.app);
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrf)
      .send({ email: 'DUP@example.com', password: PASSWORD, displayName: 'Dup' })
      .expect(409);
    expect(res.body.error.code).toBe('EMAIL_ALREADY_REGISTERED');
  });

  it('validates registration input', async () => {
    const agent = newAgent(t.app);
    const csrf = await fetchCsrf(agent);
    const res = await agent
      .post('/api/v1/auth/register')
      .set('X-CSRF-Token', csrf)
      .send({ email: 'not-an-email', password: 'short', displayName: '', role: 'admin' })
      .expect(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(
      expect.arrayContaining(['body.email', 'body.password', 'body.displayName']),
    );
    expect(res.body.error.requestId).toEqual(expect.any(String));
  });

  it('requires authentication for /me and logout', async () => {
    const agent = newAgent(t.app);
    const me = await agent.get('/api/v1/auth/me').expect(401);
    expect(me.body.error).toMatchObject({ code: 'AUTH_REQUIRED' });
    const csrf = await fetchCsrf(agent);
    await agent.post('/api/v1/auth/logout').set('X-CSRF-Token', csrf).expect(401);
  });

  it('ignores tampered session cookies', async () => {
    await supertest(t.app)
      .get('/api/v1/auth/me')
      .set('Cookie', 'content_review_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad')
      .expect(401);
  });

  it('returns errors in the standard envelope without stack traces', async () => {
    const res = await supertest(t.app)
      .post('/api/v1/auth/login')
      .set('Origin', ORIGIN)
      .send({ email: 'a@example.com', password: 'x' })
      .expect(403); // no CSRF token
    expect(Object.keys(res.body.error).sort()).toEqual(['code', 'message', 'requestId']);
    expect(JSON.stringify(res.body)).not.toMatch(/at .*\.ts/);
  });

  it('rejects malformed JSON with MALFORMED_JSON', async () => {
    const agent = newAgent(t.app);
    const { csrfToken } = await registerUser(agent);
    const res = await agent
      .post('/api/v1/reviews')
      .set('X-CSRF-Token', csrfToken)
      .set('Content-Type', 'application/json')
      .send('{"documentTitle":')
      .expect(400);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });
});
