/** Issue types produced by the Python service (contract v2). */
export const ISSUE_TYPES = [
  'spelling',
  'grammar',
  'typo',
  'punctuation',
  'clarity',
  'slang',
  'vulgarity',
  'deprecated_term',
  'inappropriate_language',
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

/**
 * Categories a stored finding (or a review's requested categories) may carry: every current
 * issue type plus `profanity`, which only appears on reviews created before contract v2.
 */
export const FINDING_CATEGORIES = [...ISSUE_TYPES, 'profanity'] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SEVERITIES = ['low', 'medium', 'high'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** Body of POST /internal/v1/content-reviews. Python rejects any other field with 422. */
export interface ContentReviewRequest {
  /** Stable per review (1-128 chars). */
  requestId: string;
  content: string;
  /** Defaults to "en" on the Python side. */
  language?: string;
  /** Gemini model chosen by the author. Omitted = the Python service's default. */
  model?: string;
}

/** Response of GET /internal/v1/content-reviews/models. */
export interface ModelCatalog {
  defaultModel: string;
  models: string[];
}

/** Why and until when the AI provider refused a request for quota reasons. */
export interface QuotaInfo {
  model: string | null;
  quotaScope: 'daily' | 'minute' | 'unknown';
  retryAfterSeconds: number | null;
  /** ISO-8601 UTC time at which the quota is expected to reset. */
  resetAt: string | null;
}

/**
 * An issue as returned by the Python service. There are no offsets: the issue is placed by
 * finding `original` in the content where it is preceded by `prefix` and followed by `suffix`.
 */
export interface ContentReviewIssue {
  id: string;
  issueType: IssueType;
  severity: FindingSeverity;
  original: string;
  improved: string;
  suggestion: string;
  location: { prefix: string; suffix: string };
}

export interface ContentReviewResponse {
  requestId: string;
  /** In document order. */
  issues: ContentReviewIssue[];
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null };
}

export interface ReviewContentOptions {
  signal?: AbortSignal;
  /** Correlation id propagated to the Python service as X-Request-ID. */
  correlationId?: string;
}

export interface LlmHealth {
  status: 'ok' | 'unavailable';
  latencyMs: number;
}
