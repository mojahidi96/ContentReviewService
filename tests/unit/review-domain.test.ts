import { describe, expect, it } from 'vitest';
import type { LlmFinding } from '../../src/integrations/python-llm/llm.types.js';
import { computeFindingId } from '../../src/modules/reviews/finding-id.js';
import { sanitizeFindings } from '../../src/modules/reviews/review-findings.js';
import {
  canTransitionFinding,
  canTransitionReview,
  isTerminalReviewStatus,
  reviewSourcesFor,
} from '../../src/modules/reviews/review-state.js';

describe('review state machine', () => {
  it.each([
    ['pending', 'processing', true],
    ['pending', 'failed', true],
    ['processing', 'processing', true],
    ['processing', 'completed', true],
    ['processing', 'failed', true],
    ['pending', 'completed', false],
    ['completed', 'processing', false],
    ['completed', 'failed', false],
    ['failed', 'processing', false],
    ['cancelled', 'pending', false],
  ] as const)('%s -> %s is %s', (from, to, allowed) => {
    expect(canTransitionReview(from, to)).toBe(allowed);
  });

  it('identifies terminal statuses', () => {
    expect(
      ['completed', 'failed', 'cancelled'].every((s) => isTerminalReviewStatus(s as 'completed')),
    ).toBe(true);
    expect(isTerminalReviewStatus('processing')).toBe(false);
  });

  it('derives source statuses for conditional updates', () => {
    expect(reviewSourcesFor('processing').sort()).toEqual(['pending', 'processing']);
    expect(reviewSourcesFor('completed')).toEqual(['processing']);
  });
});

describe('finding state machine', () => {
  it.each([
    ['pending', 'accepted', true],
    ['pending', 'dismissed', true],
    ['accepted', 'dismissed', true],
    ['dismissed', 'accepted', true],
    ['accepted', 'pending', false],
    ['resolved', 'accepted', false],
    ['resolved', 'dismissed', false],
  ] as const)('%s -> %s is %s', (from, to, allowed) => {
    expect(canTransitionFinding(from, to)).toBe(allowed);
  });
});

const finding = (overrides: Partial<LlmFinding> = {}): LlmFinding => ({
  category: 'spelling',
  severity: 'low',
  originalText: 'teh',
  suggestedText: 'the',
  explanation: 'Typo.',
  startOffset: 2,
  endOffset: 5,
  ...overrides,
});

describe('finding ids', () => {
  it('are deterministic and depend on review, category, range and text', () => {
    const a = computeFindingId('r1', finding());
    expect(a).toMatch(/^fnd_[a-f0-9]{24}$/);
    expect(computeFindingId('r1', finding({ explanation: 'Different wording.' }))).toBe(a);
    expect(computeFindingId('r2', finding())).not.toBe(a);
    expect(computeFindingId('r1', finding({ category: 'grammar' }))).not.toBe(a);
    expect(computeFindingId('r1', finding({ startOffset: 3, endOffset: 6 }))).not.toBe(a);
  });
});

describe('sanitizeFindings', () => {
  const content = 'I teh 😀 wrld';
  const now = new Date('2026-01-01T00:00:00Z');

  it('keeps valid findings sorted by offset with pending status', () => {
    const result = sanitizeFindings(
      'r1',
      content,
      ['spelling'],
      [
        finding({ originalText: 'wrld', suggestedText: 'world', startOffset: 8, endOffset: 12 }),
        finding(),
      ],
      now,
    );
    expect(result.findings.map((f) => f.originalText)).toEqual(['teh', 'wrld']);
    expect(result.findings[0]).toMatchObject({ status: 'pending', createdAt: now, updatedAt: now });
    expect(result.rejected).toEqual({});
  });

  it('counts rejections by reason and collapses duplicates', () => {
    const result = sanitizeFindings(
      'r1',
      content,
      ['spelling'],
      [
        finding(),
        finding({ suggestedText: 'tHe' }), // same id => duplicate
        finding({ category: 'profanity' }),
        finding({ startOffset: 9, endOffset: 13, originalText: 'wrld' }), // UTF-16 offsets
        finding({ originalText: 'the' }),
      ],
      now,
    );
    expect(result.findings).toHaveLength(1);
    expect(result.duplicates).toBe(1);
    expect(result.rejected).toEqual({
      CATEGORY_NOT_REQUESTED: 1,
      OUT_OF_RANGE: 1,
      TEXT_MISMATCH: 1,
    });
  });
});
