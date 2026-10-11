import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EmailService, SendOtpInput } from '../../src/infrastructure/email/email.service.js';
import { buildOtpMessage } from '../../src/infrastructure/email/email.service.js';
import { OtpModel } from '../../src/modules/auth/otp.model.js';
import { SessionModel } from '../../src/modules/auth/session.model.js';
import {
  clearTestDb,
  connectTestDb,
  createTestApp,
  disconnectTestDb,
  fetchCsrf,
  newAgent,
  PASSWORD,
  registerUser,
  type Agent,
  type TestApp,
} from '../helpers/test-app.js';

class CaptureEmail implements EmailService {
  sent: SendOtpInput[] = [];
  fail = false;
  sendOtp(input: SendOtpInput): Promise<void> {
    if (this.fail) return Promise.reject(new Error('smtp down'));
    this.sent.push(input);
    return Promise.resolve();
  }
  last(to: string, purpose?: string): SendOtpInput {
    const found = [...this.sent]
      .reverse()
      .find((m) => m.to === to && (!purpose || m.purpose === purpose));
    if (!found) throw new Error(`no email sent to ${to}`);
    return found;
  }
}

const NEW_PASSWORD = 'a brand new passphrase 42';
const A = '/api/v1/auth';
const WRONG = (code: string): string => (code === '0000' ? '0001' : '0000');

const HIGH_LIMITS = {
  OTP_REQUEST_LIMIT_PER_IP: '1000',
  OTP_REQUEST_LIMIT_PER_EMAIL: '1000',
  OTP_VERIFY_LIMIT_PER_IP: '1000',
  OTP_VERIFY_LIMIT_PER_EMAIL: '1000',
};

describe('emailed codes: sign-in and password reset', () => {
  let t: TestApp;
  const mail = new CaptureEmail();
  const logLines: string[] = [];

  beforeAll(async () => {
    await connectTestDb();
    const destination = new Writable({
      write(chunk: Buffer, _enc, cb) {
        logLines.push(chunk.toString());
        cb();
      },
    });
    t = createTestApp({
      emailService: mail,
      logDestination: destination,
      env: { ...HIGH_LIMITS, LOG_LEVEL: 'debug' },
    });
  });
  beforeEach(async () => {
    await clearTestDb();
    mail.sent = [];
    mail.fail = false;
  });
  afterAll(disconnectTestDb);

  async function post(agent: Agent, path: string, body: object, csrf?: string) {
    const token = csrf ?? (await fetchCsrf(agent));
    return agent.post(`${A}${path}`).set('X-CSRF-Token', token).send(body);
  }

  /** Requests a code and waits for the background send to finish. */
  async function requestCode(
    email: string,
    kind: 'login' | 'reset' = 'login',
    app: TestApp = t,
  ): Promise<void> {
    const res = await post(
      newAgent(app.app),
      kind === 'login' ? '/otp/request' : '/password/forgot',
      { email },
    );
    expect(res.status).toBe(202);
    await app.container.otpService.idle();
  }

  async function user() {
    const reg = await registerUser(newAgent(t.app));
    return reg;
  }

  it('signs in with an emailed code and rotates the CSRF token', async () => {
    const { email, userId } = await user();
    await requestCode(email);
    const msg = mail.last(email, 'login');
    expect(msg.code).toMatch(/^\d{4}$/);
    expect(msg.expiresInMinutes).toBe(5);

    const agent = newAgent(t.app);
    const csrf = await fetchCsrf(agent);
    const res = await post(
      agent,
      '/otp/login',
      { email: email.toUpperCase(), otp: msg.code },
      csrf,
    );
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.user).toMatchObject({ id: userId, email });
    expect(res.body.csrfToken).toEqual(expect.any(String));
    expect(res.body.csrfToken).not.toBe(csrf);
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join(';');
    expect(cookies).toMatch(/content_review_session=.*HttpOnly/i);
    await agent.get(`${A}/me`).expect(200);
    expect(await OtpModel.countDocuments()).toBe(0);
  });

  it('resets the password: old fails, new works, other sessions are revoked', async () => {
    const other = newAgent(t.app);
    const { email } = await registerUser(other);
    await other.get(`${A}/me`).expect(200);
    expect(await SessionModel.countDocuments()).toBe(1);

    await requestCode(email, 'reset');
    const { code } = mail.last(email, 'reset');
    const agent = newAgent(t.app);
    const res = await post(agent, '/password/reset', {
      email,
      otp: code,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.user.email).toBe(email);

    // The previously logged-in session is gone; only the new one remains.
    await other.get(`${A}/me`).expect(401);
    expect(await SessionModel.countDocuments()).toBe(1);
    await agent.get(`${A}/me`).expect(200);

    const fresh = newAgent(t.app);
    await post(fresh, '/login', { email, password: PASSWORD }).then((r) =>
      expect(r.status).toBe(401),
    );
    await post(fresh, '/login', { email, password: NEW_PASSWORD }).then((r) =>
      expect(r.status).toBe(200),
    );
  });

  it('returns the same 202 for known and unknown emails and sends mail only to known ones', async () => {
    const { email } = await user();
    const known = await post(newAgent(t.app), '/otp/request', { email });
    const unknown = await post(newAgent(t.app), '/otp/request', { email: 'nobody@example.com' });
    const knownReset = await post(newAgent(t.app), '/password/forgot', { email });
    const unknownReset = await post(newAgent(t.app), '/password/forgot', {
      email: 'nobody@example.com',
    });
    await t.container.otpService.idle();

    for (const r of [known, unknown, knownReset, unknownReset]) {
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ expiresInSeconds: 300 });
      expect(r.headers['cache-control']).toBe('no-store');
    }
    expect(mail.sent.map((m) => m.to)).toEqual([email, email]);
  });

  it('stays 202 and logs the failure when email delivery fails', async () => {
    const { email } = await user();
    mail.fail = true;
    logLines.length = 0;
    await requestCode(email);
    expect(mail.sent).toHaveLength(0);
    expect(logLines.join('')).toContain('could not be sent');
  });

  it('answers 401 OTP_INVALID for unknown email, wrong code and missing code alike', async () => {
    const { email } = await user();
    const unknown = await post(newAgent(t.app), '/otp/login', {
      email: 'nobody@example.com',
      otp: '1234',
    });
    const missing = await post(newAgent(t.app), '/otp/login', { email, otp: '1234' });
    await requestCode(email);
    const wrong = await post(newAgent(t.app), '/otp/login', {
      email,
      otp: WRONG(mail.last(email).code),
    });
    for (const r of [unknown, missing, wrong]) {
      expect(r.status).toBe(401);
      expect(r.body.error).toMatchObject({
        code: 'OTP_INVALID',
        message: 'The code is invalid or has expired.',
      });
      expect(r.body.error.requestId).toEqual(expect.any(String));
    }
  });

  it('counts failed attempts and blocks the 6th, even with the correct code', async () => {
    const { email, userId } = await user();
    await requestCode(email);
    const { code } = mail.last(email);
    const agent = newAgent(t.app);
    const csrf = await fetchCsrf(agent);

    for (let i = 1; i <= 4; i++) {
      await post(agent, '/otp/login', { email, otp: WRONG(code) }, csrf).then((r) =>
        expect(r.status).toBe(401),
      );
      expect((await OtpModel.findOne({ userId }))?.attempts).toBe(i);
    }
    await post(agent, '/otp/login', { email, otp: WRONG(code) }, csrf).then((r) =>
      expect(r.status).toBe(401),
    );
    expect(await OtpModel.countDocuments()).toBe(0); // deleted after the 5th failure
    const sixth = await post(agent, '/otp/login', { email, otp: code }, csrf);
    expect(sixth.status).toBe(401);
    expect(sixth.body.error.code).toBe('OTP_INVALID');
  });

  it('rejects an expired code', async () => {
    const { email } = await user();
    await requestCode(email);
    const { code } = mail.last(email);
    await OtpModel.updateMany({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await post(newAgent(t.app), '/otp/login', { email, otp: code });
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('OTP_INVALID');
  });

  it('rejects reuse of a consumed code', async () => {
    const { email } = await user();
    await requestCode(email);
    const { code } = mail.last(email);
    await post(newAgent(t.app), '/otp/login', { email, otp: code }).then((r) =>
      expect(r.status).toBe(200),
    );
    const again = await post(newAgent(t.app), '/otp/login', { email, otp: code });
    expect(again.status).toBe(401);
  });

  it('only one of several concurrent uses of a code succeeds', async () => {
    const { email } = await user();
    await requestCode(email);
    const { code } = mail.last(email);
    const results = await Promise.all(
      Array.from({ length: 4 }, () => post(newAgent(t.app), '/otp/login', { email, otp: code })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('keeps login and reset codes independent', async () => {
    const { email } = await user();
    await requestCode(email, 'login');
    await requestCode(email, 'reset');
    expect(await OtpModel.countDocuments()).toBe(2);

    const login = mail.last(email, 'login').code;
    const reset = mail.last(email, 'reset').code;
    if (login !== reset) {
      // A code for one purpose never verifies for the other.
      const wrongPurpose = await post(newAgent(t.app), '/password/reset', {
        email,
        otp: login,
        newPassword: NEW_PASSWORD,
      });
      expect(wrongPurpose.status).toBe(401);
      const wrongPurpose2 = await post(newAgent(t.app), '/otp/login', { email, otp: reset });
      expect(wrongPurpose2.status).toBe(401);
    }
    // Each purpose still works with its own code (failed attempts above were per-document).
    await requestCode(email, 'login');
    await post(newAgent(t.app), '/otp/login', { email, otp: mail.last(email, 'login').code }).then(
      (r) => expect(r.status).toBe(200),
    );
    expect(await OtpModel.countDocuments({ purpose: 'reset' })).toBe(1);
  });

  it('a new request replaces the previous code', async () => {
    const { email } = await user();
    let first = '';
    let second = '';
    for (let i = 0; i < 5 && first === second; i++) {
      await requestCode(email);
      first = mail.last(email).code;
      await requestCode(email);
      second = mail.last(email).code;
    }
    expect(await OtpModel.countDocuments()).toBe(1);
    expect((await OtpModel.findOne())?.attempts).toBe(0);
    expect(first).not.toBe(second); // 1-in-10^4 chance of 5 collisions in a row
    await post(newAgent(t.app), '/otp/login', { email, otp: first }).then((r) =>
      expect(r.status).toBe(401),
    );
    await requestCode(email);
    await post(newAgent(t.app), '/otp/login', { email, otp: mail.last(email).code }).then((r) =>
      expect(r.status).toBe(200),
    );
  });

  it('stores only an HMAC of the code', async () => {
    const { email } = await user();
    await requestCode(email);
    const { code } = mail.last(email);
    const record = await OtpModel.findOne().lean();
    expect(record?.codeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(record)).not.toContain(`"${code}"`);
  });

  describe('validation and CSRF', () => {
    it.each([
      ['/otp/request', { email: 'a@example.com', extra: 1 }, 'body'],
      ['/password/forgot', { email: 'not-an-email' }, 'body.email'],
      ['/otp/login', { email: 'a@example.com', otp: 'abcd' }, 'body.otp'],
      ['/otp/login', { email: 'a@example.com', otp: '123' }, 'body.otp'],
      ['/otp/login', { email: 'a@example.com', otp: '12345' }, 'body.otp'],
      ['/otp/login', { email: 'a@example.com', otp: 1234 }, 'body.otp'],
      ['/otp/login', { email: 'a@example.com', otp: '1234', x: 1 }, 'body'],
      [
        '/password/reset',
        { email: 'a@example.com', otp: '1234', newPassword: 'short' },
        'body.newPassword',
      ],
      [
        '/password/reset',
        { email: 'a@example.com', otp: '12x4', newPassword: NEW_PASSWORD },
        'body.otp',
      ],
      [
        '/password/reset',
        { email: 'a@example.com', otp: '1234', newPassword: 'é'.repeat(40) },
        'body.newPassword',
      ],
    ])('400 VALIDATION_FAILED for %s %j', async (path, body, detailPath) => {
      const res = await post(newAgent(t.app), path, body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
      expect(paths.some((p) => p === detailPath || p.startsWith(detailPath))).toBe(true);
    });

    it.each([
      ['/otp/request', { email: 'a@example.com' }],
      ['/password/forgot', { email: 'a@example.com' }],
      ['/otp/login', { email: 'a@example.com', otp: '1234' }],
      ['/password/reset', { email: 'a@example.com', otp: '1234', newPassword: NEW_PASSWORD }],
    ])('403 CSRF_INVALID without a token: %s', async (path, body) => {
      const res = await newAgent(t.app).post(`${A}${path}`).send(body);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('CSRF_INVALID');
    });
  });

  it('never logs codes, code hashes or passwords', async () => {
    const { email } = await user();
    logLines.length = 0;
    await requestCode(email, 'reset');
    const { code } = mail.last(email, 'reset');
    const hash = (await OtpModel.findOne().lean())!.codeHash;
    await post(newAgent(t.app), '/password/reset', {
      email,
      otp: WRONG(code),
      newPassword: NEW_PASSWORD,
    });
    await post(newAgent(t.app), '/password/reset', { email, otp: code, newPassword: NEW_PASSWORD });

    const logs = logLines.join('');
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(hash);
    expect(logs).not.toContain(NEW_PASSWORD);
    expect(logs).not.toContain(PASSWORD);
    expect(logs).not.toContain(`"${code}"`);
    expect(logs).not.toMatch(/"otp"|"newPassword"|codeHash/);
  });
});

describe('emailed codes: rate limits', () => {
  let t: TestApp;
  const mail = new CaptureEmail();

  beforeAll(async () => {
    await connectTestDb();
    t = createTestApp({
      emailService: mail,
      env: {
        ...HIGH_LIMITS,
        OTP_REQUEST_LIMIT_PER_EMAIL: '3',
        OTP_VERIFY_LIMIT_PER_EMAIL: '3',
      },
    });
  });
  beforeEach(clearTestDb);
  afterAll(disconnectTestDb);

  async function request(email: string) {
    const agent = newAgent(t.app);
    const csrf = await fetchCsrf(agent);
    return agent.post(`${A}/otp/request`).set('X-CSRF-Token', csrf).send({ email });
  }

  it('limits code requests per email, whether or not the account exists', async () => {
    const { email } = await registerUser(newAgent(t.app));
    for (const target of [email, 'ghost@example.com']) {
      for (let i = 0; i < 3; i++) expect((await request(target)).status).toBe(202);
      const limited = await request(target);
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('RATE_LIMITED');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    }
    // Other emails are unaffected.
    expect((await request('someone-else@example.com')).status).toBe(202);
    // Email matching ignores case and surrounding spaces.
    expect((await request(' GHOST@example.com ')).status).toBe(429);
  });

  it('limits failed verifications per email', async () => {
    const email = 'ghost@example.com';
    const attempt = async () => {
      const agent = newAgent(t.app);
      const csrf = await fetchCsrf(agent);
      return agent.post(`${A}/otp/login`).set('X-CSRF-Token', csrf).send({ email, otp: '0000' });
    };
    for (let i = 0; i < 3; i++) expect((await attempt()).status).toBe(401);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBeDefined();
  });
});

describe('otp email content', () => {
  it('uses different wording per purpose and contains no links', () => {
    const login = buildOtpMessage({ code: '0420', purpose: 'login', expiresInMinutes: 5 });
    const reset = buildOtpMessage({ code: '0420', purpose: 'reset', expiresInMinutes: 5 });
    expect(login.text).toBe(
      "Your ContentReview sign-in code is 0420. It expires in 5 minutes. If you didn't request it, ignore this email.",
    );
    expect(reset.text).toContain('password reset code is 0420');
    expect(login.subject).not.toBe(reset.subject);
    for (const m of [login, reset]) {
      expect(m.text + m.html).not.toMatch(/https?:|href/i);
      expect(m.html).toContain('<strong>0420</strong>');
    }
  });
});
