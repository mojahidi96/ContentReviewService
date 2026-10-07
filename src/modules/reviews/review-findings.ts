import type { ContentReviewIssue } from '../../integrations/python-llm/llm.types.js';
import { computeFindingId } from './finding-id.js';
import { locateIssue } from './issue-locator.js';
import type { FindingRecord } from './review.model.js';

export interface ResolvedFindings {
  findings: FindingRecord[];
  /** Issues whose `original` text is not in the content. */
  notFound: number;
  /** Issues placed on the closest match because no occurrence had exactly their prefix/suffix. */
  approximate: number;
  duplicates: number;
}

/**
 * Turns Python issues (text anchors, no offsets) into findings with code-point offsets into the
 * stored content. Unplaceable issues are dropped, and duplicates collapse onto one
 * deterministic finding id.
 */
export function resolveIssues(
  reviewId: string,
  content: string,
  issues: readonly ContentReviewIssue[],
  now: Date,
): ResolvedFindings {
  const byId = new Map<string, FindingRecord>();
  let notFound = 0;
  let approximate = 0;
  let duplicates = 0;
  // Issues arrive in document order; start each search where the previous issue was placed.
  let cursor = 0;

  for (const issue of issues) {
    const located = locateIssue(content, { original: issue.original, ...issue.location }, cursor);
    if (!located.found) {
      notFound++;
      continue;
    }
    cursor = located.utf16Index;
    if (!located.exactContext) approximate++;

    const placed = {
      category: issue.issueType,
      startOffset: located.startOffset,
      endOffset: located.endOffset,
      originalText: issue.original,
    };
    const findingId = computeFindingId(reviewId, placed);
    if (byId.has(findingId)) {
      duplicates++;
      continue;
    }
    byId.set(findingId, {
      findingId,
      ...placed,
      severity: issue.severity,
      suggestedText: issue.improved,
      explanation: issue.suggestion,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    });
  }

  const findings = [...byId.values()].sort(
    (a, b) =>
      a.startOffset - b.startOffset ||
      a.endOffset - b.endOffset ||
      a.findingId.localeCompare(b.findingId),
  );
  return { findings, notFound, approximate, duplicates };
}
