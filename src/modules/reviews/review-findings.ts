import type { FindingCategory, LlmFinding } from '../../integrations/python-llm/llm.types.js';
import {
  toCodePoints,
  validateOffsets,
  type OffsetValidationResult,
} from '../../shared/utils/offsets.js';
import { computeFindingId } from './finding-id.js';
import type { FindingRecord } from './review.model.js';

type RejectReason =
  Exclude<OffsetValidationResult, { valid: true }>['reason'] | 'CATEGORY_NOT_REQUESTED';

export interface SanitizedFindings {
  findings: FindingRecord[];
  rejected: Partial<Record<RejectReason, number>>;
  duplicates: number;
}

/**
 * Node's independent validation of findings that already passed the contract schema:
 * offsets must reference exactly `originalText` in the stored content, categories must have
 * been requested, and duplicates collapse onto one deterministic finding id.
 */
export function sanitizeFindings(
  reviewId: string,
  content: string,
  requestedCategories: readonly FindingCategory[],
  llmFindings: readonly LlmFinding[],
  now: Date,
): SanitizedFindings {
  const codePoints = toCodePoints(content);
  const byId = new Map<string, FindingRecord>();
  const rejected: SanitizedFindings['rejected'] = {};
  let duplicates = 0;

  for (const f of llmFindings) {
    if (!requestedCategories.includes(f.category)) {
      rejected.CATEGORY_NOT_REQUESTED = (rejected.CATEGORY_NOT_REQUESTED ?? 0) + 1;
      continue;
    }
    const check = validateOffsets(codePoints, f.startOffset, f.endOffset, f.originalText);
    if (!check.valid) {
      rejected[check.reason] = (rejected[check.reason] ?? 0) + 1;
      continue;
    }
    const findingId = computeFindingId(reviewId, f);
    if (byId.has(findingId)) {
      duplicates++;
      continue;
    }
    byId.set(findingId, {
      findingId,
      category: f.category,
      severity: f.severity,
      originalText: f.originalText,
      suggestedText: f.suggestedText,
      explanation: f.explanation,
      startOffset: f.startOffset,
      endOffset: f.endOffset,
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
  return { findings, rejected, duplicates };
}
