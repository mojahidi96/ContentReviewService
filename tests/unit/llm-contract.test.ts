import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../../src/integrations/python-llm/http-llm-client.js';
import {
  isRetryableError,
  LlmAbortedError,
  LlmBadResponseError,
  LlmContentTooLargeError,
  LlmRateLimitedError,
  LlmRejectedError,
  LlmTimeoutError,
  LlmUnavailableError,
  shouldRetry,
} from '../../src/integrations/python-llm/llm.errors.js';
import {
  contentReviewResponseSchema,
  LLM_LIMITS,
} from '../../src/integrations/python-llm/llm.schemas.js';
import { computeBackoffMs } from '../../src/shared/utils/backoff.js';
import { validContentReviewResponse } from '../fixtures/python-responses.js';

describe('Python response schema', () => {
  it('accepts the documented example', () => {
    const body = {
      requestId: 'review_123',
      issues: [
        {
          id: 'issue-3f9a1c2b7d10',
          issueType: 'spelling',
          severity: 'low',
          original: 'recieve',
          improved: 'receive',
          suggestion: 'Correct the spelling mistake.',
          location: { prefix: 'Please ', suffix: ' the document.' },
        },
      ],
      model: 'gemini-2.5-flash',
      usage: { inputTokens: null, outputTokens: null },
    };
    expect(contentReviewResponseSchema.parse(body)).toEqual(body);
  });

  it('strips unknown fields (forward compatible)', () => {
    const body = validContentReviewResponse('r1');
    const parsed = contentReviewResponseSchema.parse({
      ...body,
      newTopLevelField: 1,
      issues: [{ ...body.issues[0], confidence: 0.9 }],
    });
    expect(parsed).not.toHaveProperty('newTopLevelField');
    expect(parsed.issues[0]).not.toHaveProperty('confidence');
  });

  it('accepts every documented issue type and empty prefix/suffix', () => {
    const body = validContentReviewResponse('r1');
    for (const issueType of [
      'spelling',
      'grammar',
      'typo',
      'punctuation',
      'clarity',
      'slang',
      'vulgarity',
      'deprecated_term',
      'inappropriate_language',
    ]) {
      const issues = [{ ...body.issues[0], issueType, location: { prefix: '', suffix: '' } }];
      expect(contentReviewResponseSchema.safeParse({ ...body, issues }).success).toBe(true);
    }
  });

  it.each([
    ['empty original', { original: '' }],
    ['empty suggestion', { suggestion: '' }],
    ['empty id', { id: '' }],
    ['unknown severity', { severity: 'critical' }],
    ['unknown issueType', { issueType: 'profanity' }],
    ['overlong suggestion', { suggestion: 'x'.repeat(LLM_LIMITS.maxSuggestion + 1) }],
    ['lone surrogate', { improved: '\ud800' }],
    ['missing location', { location: undefined }],
  ])('rejects %s', (_name, override) => {
    const body = validContentReviewResponse('r1');
    const bad = { ...body, issues: [{ ...body.issues[0], ...override }] };
    expect(contentReviewResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('requires model and usage', () => {
    const { model: _m, ...noModel } = validContentReviewResponse('r1');
    const { usage: _u, ...noUsage } = validContentReviewResponse('r1');
    expect(contentReviewResponseSchema.safeParse(noModel).success).toBe(false);
    expect(contentReviewResponseSchema.safeParse(noUsage).success).toBe(false);
  });

  it('caps the number of issues', () => {
    const body = validContentReviewResponse('r1');
    const many = { ...body, issues: Array(LLM_LIMITS.maxIssues + 1).fill(body.issues[0]) };
    expect(contentReviewResponseSchema.safeParse(many).success).toBe(false);
  });
});

describe('retry decisions', () => {
  it.each([
    [new LlmTimeoutError('t'), true],
    [new LlmUnavailableError('u'), true],
    [new LlmRateLimitedError('r'), true],
    [new LlmBadResponseError('b'), true],
    [new LlmAbortedError('a'), true],
    [new LlmRejectedError('x', 400), false],
    [new LlmContentTooLargeError('x'), false],
    [new Error('db blip'), true],
  ])('%o retryable=%s', (err, expected) => {
    expect(isRetryableError(err)).toBe(expected);
  });

  // attempt is 1-based: attempt N failing means N-1 retries have been used.
  it.each([
    ['INVALID_MODEL_OUTPUT retries once', new LlmBadResponseError('b'), [true, false]],
    [
      '503 retries at most twice',
      new LlmUnavailableError('u', { maxRetries: 2 }),
      [true, true, false],
    ],
    [
      'quota exhaustion uses the job budget',
      new LlmRateLimitedError('r'),
      [true, true, true, false],
    ],
    [
      'transport failures use the job budget',
      new LlmUnavailableError('u'),
      [true, true, true, false],
    ],
    ['401/422 never retry', new LlmRejectedError('x', 401), [false]],
    ['413 never retries', new LlmContentTooLargeError('x'), [false]],
  ])('%s', (_name, err, expected) => {
    const maxAttempts = 4;
    const decisions = expected.map((_, i) => shouldRetry(err, i + 1, maxAttempts));
    expect(decisions).toEqual(expected);
  });

  it('exposes safe public messages and stable codes', () => {
    const err = new LlmUnavailableError('connect ECONNREFUSED 10.0.0.5:8000');
    expect(err.code).toBe('LLM_SERVICE_UNAVAILABLE');
    expect(err.publicMessage).not.toMatch(/10\.0\.0\.5|ECONNREFUSED/);
  });

  it('computes bounded exponential backoff with jitter', () => {
    const opts = { baseMs: 1000, maxMs: 8000 };
    expect(computeBackoffMs(1, { ...opts, random: () => 0 })).toBe(500);
    expect(computeBackoffMs(1, { ...opts, random: () => 0.999999 })).toBe(1000);
    expect(computeBackoffMs(3, { ...opts, random: () => 1 })).toBe(4000);
    expect(computeBackoffMs(10, { ...opts, random: () => 1 })).toBe(8000);
    for (let attempt = 1; attempt < 20; attempt++) {
      const d = computeBackoffMs(attempt, opts);
      expect(d).toBeGreaterThanOrEqual(250);
      expect(d).toBeLessThanOrEqual(8000);
    }
  });

  it('parses Retry-After seconds and dates, capped at 10 minutes', () => {
    const now = Date.parse('2026-10-04T00:00:00Z');
    expect(parseRetryAfter('5', now)).toBe(5000);
    expect(parseRetryAfter('99999', now)).toBe(600_000);
    expect(parseRetryAfter('Sun, 04 Oct 2026 00:00:30 GMT', now)).toBe(30_000);
    expect(parseRetryAfter('garbage', now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });
});
