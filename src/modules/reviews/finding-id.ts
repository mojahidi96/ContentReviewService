import { sha256Hex } from '../../shared/utils/hash.js';
import type { LlmFinding } from '../../integrations/python-llm/llm.types.js';

/**
 * Deterministic finding id: the same finding produced by a retried job gets the same id,
 * so retries and duplicate deliveries cannot create duplicates.
 */
export function computeFindingId(reviewId: string, finding: LlmFinding): string {
  const key = [
    reviewId,
    finding.category,
    finding.startOffset,
    finding.endOffset,
    finding.originalText,
  ].join('\u0000');
  return `fnd_${sha256Hex(key).slice(0, 24)}`;
}
