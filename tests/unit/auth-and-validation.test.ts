import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import {
  signSessionToken,
  verifySessionToken,
  type JwtConfig,
} from '../../src/modules/auth/jwt.js';
import { hashPassword, verifyPassword } from '../../src/modules/auth/password.js';
import { loginBodySchema, registerBodySchema } from '../../src/modules/auth/auth.schemas.js';
import { parseLastEventId } from '../../src/modules/reviews/review-sse.controller.js';
import {
  createReviewBodySchema,
  findingParamsSchema,
  listReviewsQuerySchema,
  updateFindingBodySchema,
} from '../../src/modules/reviews/review.schemas.js';

const config: JwtConfig = {
  secret: 's'.repeat(40),
  issuer: 'iss',
  audience: 'aud',
  ttlSeconds: 60,
};

describe('session tokens', () => {
  it('round-trips user and session ids', () => {
    const token = signSessionToken({ userId: 'u1', sessionId: 's1' }, config);
    expect(verifySessionToken(token, config)).toEqual({ userId: 'u1', sessionId: 's1' });
  });

  it('rejects tampered, expired, wrong-audience and alg=none tokens', () => {
    const token = signSessionToken({ userId: 'u1', sessionId: 's1' }, config);
    expect(verifySessionToken(`${token}x`, config)).toBeNull();
    expect(verifySessionToken(token, { ...config, secret: 't'.repeat(40) })).toBeNull();
    expect(verifySessionToken(token, { ...config, audience: 'other' })).toBeNull();

    const expired = jwt.sign(
      { sub: 'u1', jti: 's1', exp: Math.floor(Date.now() / 1000) - 10 },
      config.secret,
      {
        issuer: 'iss',
        audience: 'aud',
      },
    );
    expect(verifySessionToken(expired, config)).toBeNull();

    const none = jwt.sign({ sub: 'u1', jti: 's1' }, '', {
      algorithm: 'none',
      issuer: 'iss',
      audience: 'aud',
    });
    expect(verifySessionToken(none, config)).toBeNull();
  });

  it('rejects tokens without sub or jti', () => {
    const noJti = jwt.sign({}, config.secret, { subject: 'u1', issuer: 'iss', audience: 'aud' });
    expect(verifySessionToken(noJti, config)).toBeNull();
  });
});

describe('password hashing', () => {
  it('hashes with a salt and verifies', async () => {
    const a = await hashPassword('correct horse', 4);
    const b = await hashPassword('correct horse', 4);
    expect(a).not.toBe(b);
    expect(a).not.toContain('correct horse');
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
  });
});

describe('request schemas', () => {
  it('normalizes auth input and enforces password rules', () => {
    expect(
      registerBodySchema.parse({
        email: ' A@B.co ',
        password: 'x'.repeat(12),
        displayName: ' Ann ',
      }),
    ).toEqual({ email: 'A@B.co', password: 'x'.repeat(12), displayName: 'Ann' });
    expect(
      registerBodySchema.safeParse({ email: 'a@b.co', password: 'x'.repeat(11), displayName: 'A' })
        .success,
    ).toBe(false);
    // 73 bytes exceeds bcrypt's input limit.
    expect(
      registerBodySchema.safeParse({ email: 'a@b.co', password: 'é'.repeat(37), displayName: 'A' })
        .success,
    ).toBe(false);
    expect(loginBodySchema.safeParse({ email: 'a@b.co', password: 'x', extra: true }).success).toBe(
      false,
    );
  });

  it('validates review creation', () => {
    const schema = createReviewBodySchema(10);
    const ok = schema.parse({ documentTitle: ' T ', content: '  keep  ', categories: ['grammar'] });
    expect(ok).toEqual({ documentTitle: 'T', content: '  keep  ', categories: ['grammar'] });
    expect(
      schema.safeParse({ documentTitle: 'T', content: '\ud800', categories: ['grammar'] }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ documentTitle: 'T', content: '😀'.repeat(10), categories: ['grammar'] })
        .success,
    ).toBe(true);
    expect(
      schema.safeParse({ documentTitle: 'T', content: '😀'.repeat(11), categories: ['grammar'] })
        .success,
    ).toBe(false);
  });

  it('validates list queries with defaults', () => {
    expect(listReviewsQuerySchema.parse({})).toEqual({ page: 1, limit: 20 });
    expect(listReviewsQuerySchema.parse({ page: '2', limit: '5', status: 'failed' })).toEqual({
      page: 2,
      limit: 5,
      status: 'failed',
    });
    expect(listReviewsQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listReviewsQuerySchema.safeParse({ sort: 'x' }).success).toBe(false);
  });

  it('validates finding updates and ids', () => {
    expect(updateFindingBodySchema.safeParse({ status: 'accepted' }).success).toBe(true);
    expect(updateFindingBodySchema.safeParse({ status: 'resolved' }).success).toBe(false);
    expect(
      findingParamsSchema.safeParse({
        reviewId: '0123456789abcdef01234567',
        findingId: 'fnd_0123456789abcdef01234567',
      }).success,
    ).toBe(true);
    expect(
      findingParamsSchema.safeParse({ reviewId: '{"$gt":""}', findingId: 'fnd_x' }).success,
    ).toBe(false);
  });

  it('parses Last-Event-ID defensively', () => {
    expect(parseLastEventId('42')).toBe(42);
    expect(parseLastEventId(' 7 ')).toBe(7);
    expect(parseLastEventId('-1')).toBeUndefined();
    expect(parseLastEventId('abc')).toBeUndefined();
    expect(parseLastEventId(undefined)).toBeUndefined();
  });
});
