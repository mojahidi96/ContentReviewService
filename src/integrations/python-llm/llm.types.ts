export const FINDING_CATEGORIES = ['grammar', 'spelling', 'profanity'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SEVERITIES = ['low', 'medium', 'high'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export interface AnalysisRequest {
  /** Stable per review; Python must treat repeated calls with the same id idempotently. */
  requestId: string;
  content: string;
  categories: FindingCategory[];
  language: string;
}

/** A finding as returned by the Python service (offsets in Unicode code points, [start, end)). */
export interface LlmFinding {
  category: FindingCategory;
  severity: FindingSeverity;
  originalText: string;
  suggestedText: string;
  explanation: string;
  startOffset: number;
  endOffset: number;
}

/**
 * Units produced by a client. Today the HTTP client yields a single `result` chunk; a future
 * streaming client can yield `findings` batches followed by `result` without changing the
 * review domain, which consumes chunks generically.
 */
export type AnalysisChunk =
  | { type: 'findings'; findings: LlmFinding[] }
  | { type: 'result'; findings: LlmFinding[]; model?: string | undefined };

export interface AnalyzeOptions {
  signal?: AbortSignal;
  /** Correlation id propagated to the Python service as X-Request-Id. */
  correlationId?: string;
}

export interface LlmHealth {
  status: 'ok' | 'unavailable';
  latencyMs: number;
}
