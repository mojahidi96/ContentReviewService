import { describe, expect, it } from 'vitest';
import type { ContentReviewIssue } from '../../src/integrations/python-llm/llm.types.js';
import { computeFindingId } from '../../src/modules/reviews/finding-id.js';
import { resolveIssues } from '../../src/modules/reviews/review-findings.js';
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

const placed = (
  overrides: Partial<Parameters<typeof computeFindingId>[1]> = {},
): Parameters<typeof computeFindingId>[1] => ({
  category: 'spelling',
  originalText: 'teh',
  startOffset: 2,
  endOffset: 5,
  ...overrides,
});

describe('finding ids', () => {
  it('are deterministic and depend on review, category, range and text', () => {
    const a = computeFindingId('r1', placed());
    expect(a).toMatch(/^fnd_[a-f0-9]{24}$/);
    expect(computeFindingId('r1', placed())).toBe(a);
    expect(computeFindingId('r2', placed())).not.toBe(a);
    expect(computeFindingId('r1', placed({ category: 'grammar' }))).not.toBe(a);
    expect(computeFindingId('r1', placed({ startOffset: 3, endOffset: 6 }))).not.toBe(a);
  });
});

const issue = (overrides: Partial<ContentReviewIssue> = {}): ContentReviewIssue => ({
  id: 'issue-1',
  issueType: 'spelling',
  severity: 'low',
  original: 'teh',
  improved: 'the',
  suggestion: 'Correct the spelling mistake.',
  location: { prefix: 'I ', suffix: ' 😀 wrld' },
  ...overrides,
});

describe('resolveIssues', () => {
  const content = 'I teh 😀 wrld';
  const now = new Date('2026-01-01T00:00:00Z');

  it('maps issues to findings with code-point offsets, sorted, pending', () => {
    const result = resolveIssues(
      'r1',
      content,
      [
        issue(),
        issue({
          id: 'issue-2',
          original: 'wrld',
          improved: 'world',
          location: { prefix: '😀 ', suffix: '' },
        }),
      ],
      now,
    );
    expect(result).toMatchObject({ notFound: 0, approximate: 0, duplicates: 0 });
    expect(result.findings).toEqual([
      {
        findingId: computeFindingId('r1', placed()),
        category: 'spelling',
        severity: 'low',
        originalText: 'teh',
        suggestedText: 'the',
        explanation: 'Correct the spelling mistake.',
        startOffset: 2,
        endOffset: 5,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
      expect.objectContaining({ originalText: 'wrld', startOffset: 8, endOffset: 12 }),
    ]);
  });

  it('drops issues not in the content, counts approximate placements, collapses duplicates', () => {
    const result = resolveIssues(
      'r1',
      content,
      [
        issue(),
        issue({ id: 'issue-dup', improved: 'tHe' }), // same placement => same finding id
        issue({ id: 'issue-gone', original: 'missing' }),
        issue({ id: 'issue-ctx', original: 'wrld', location: { prefix: 'xx ', suffix: '!' } }),
      ],
      now,
    );
    expect(result.findings.map((f) => f.originalText)).toEqual(['teh', 'wrld']);
    expect(result).toMatchObject({ notFound: 1, approximate: 1, duplicates: 1 });
  });

  it('places repeated text by its context and document order', () => {
    const text = 'teh cat and teh dog and teh cat';
    const result = resolveIssues(
      'r1',
      text,
      [
        issue({ id: 'a', location: { prefix: '', suffix: ' cat and' } }),
        issue({ id: 'b', location: { prefix: 'and ', suffix: ' dog' } }),
        issue({ id: 'c', location: { prefix: 'and ', suffix: ' cat' } }),
      ],
      now,
    );
    expect(result.findings.map((f) => f.startOffset)).toEqual([0, 12, 24]);
    expect(result.approximate).toBe(0);
  });

  it('keeps every issue type as the finding category', () => {
    const result = resolveIssues(
      'r1',
      'Gonna send it, damn.',
      [
        issue({
          issueType: 'slang',
          original: 'Gonna',
          improved: 'Going to',
          location: { prefix: '', suffix: ' send' },
        }),
        issue({
          issueType: 'vulgarity',
          severity: 'high',
          original: 'damn',
          improved: '',
          location: { prefix: 'it, ', suffix: '.' },
        }),
      ],
      now,
    );
    expect(result.findings.map((f) => [f.category, f.suggestedText])).toEqual([
      ['slang', 'Going to'],
      ['vulgarity', ''],
    ]);
  });
});
