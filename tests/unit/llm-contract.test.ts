import { describe, expect, it } from 'vitest';
import { parseRetryAfter } from '../../src/integrations/python-llm/http-llm-client.js';
import {
  isRetryableError,
  LlmAbortedError,
  LlmBadResponseError,
  LlmRateLimitedError,
  LlmRejectedError,
  LlmTimeoutError,
  LlmUnavailableError,
} from '../../src/integrations/python-llm/llm.errors.js';
import {
  analysisResponseSchema,
  LLM_LIMITS,
} from '../../src/integrations/python-llm/llm.schemas.js';
import { computeBackoffMs } from '../../src/shared/utils/backoff.js';
import { sliceByCodePoints } from '../../src/shared/utils/offsets.js';
import { validAnalysisResponse } from '../fixtures/python-responses.js';

describe('Python response schema', () => {
  it('accepts the documented example and its offsets reference the request content', () => {
    const parsed = analysisResponseSchema.parse(validAnalysisResponse('r1'));
    for (const f of parsed.findings) {
      expect(
        sliceByCodePoints('The report have several mistake.', f.startOffset, f.endOffset),
      ).toBe(f.originalText);
    }
  });

  it('strips unknown fields (forward compatible) and allows a missing model', () => {
    const { model: _model, ...rest } = validAnalysisResponse('r1');
    const parsed = analysisResponseSchema.parse({ ...rest, newTopLevelField: 1 });
    expect(parsed).not.toHaveProperty('newTopLevelField');
  });

  it.each([
    ['empty originalText', { originalText: '' }],
    ['empty explanation', { explanation: '' }],
    ['float offset', { startOffset: 1.5 }],
    ['zero endOffset', { endOffset: 0 }],
    ['unknown severity', { severity: 'critical' }],
    ['overlong explanation', { explanation: 'x'.repeat(LLM_LIMITS.maxExplanation + 1) }],
    ['lone surrogate', { suggestedText: '\ud800' }],
  ])('rejects %s', (_name, override) => {
    const body = validAnalysisResponse('r1');
    const bad = { ...body, findings: [{ ...body.findings[0], ...override }] };
    expect(analysisResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('caps the number of findings', () => {
    const body = validAnalysisResponse('r1');
    const many = { ...body, findings: Array(LLM_LIMITS.maxFindings + 1).fill(body.findings[0]) };
    expect(analysisResponseSchema.safeParse(many).success).toBe(false);
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
    [new Error('db blip'), true],
  ])('%o retryable=%s', (err, expected) => {
    expect(isRetryableError(err)).toBe(expected);
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
