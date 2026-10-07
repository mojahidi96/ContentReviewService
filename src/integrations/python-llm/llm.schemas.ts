import { z } from 'zod';
import { FINDING_SEVERITIES, ISSUE_TYPES } from './llm.types.js';

/** Upper bounds that protect storage and the UI from runaway model output. */
export const LLM_LIMITS = {
  maxIssues: 1000,
  maxIssueId: 200,
  maxOriginal: 10_000,
  maxImproved: 10_000,
  maxSuggestion: 2_000,
  maxContext: 2_000,
} as const;

/** Largest `content` the Python service accepts (characters). */
export const PYTHON_MAX_CONTENT_CHARS = 100_000;

const wellFormed = (s: string) => s.isWellFormed();

export const contentReviewIssueSchema = z.object({
  id: z.string().min(1).max(LLM_LIMITS.maxIssueId),
  issueType: z.enum(ISSUE_TYPES),
  severity: z.enum(FINDING_SEVERITIES),
  original: z.string().min(1).max(LLM_LIMITS.maxOriginal).refine(wellFormed),
  improved: z.string().max(LLM_LIMITS.maxImproved).refine(wellFormed),
  suggestion: z.string().min(1).max(LLM_LIMITS.maxSuggestion).refine(wellFormed),
  location: z.object({
    // Either may be empty at the start or end of the content.
    prefix: z.string().max(LLM_LIMITS.maxContext).refine(wellFormed),
    suffix: z.string().max(LLM_LIMITS.maxContext).refine(wellFormed),
  }),
});

const tokenCount = z.number().int().nonnegative().nullable();

/**
 * Response of POST /internal/v1/content-reviews (contract v2).
 * Unknown fields are ignored (stripped) for forward compatibility; known fields are strict.
 */
export const contentReviewResponseSchema = z.object({
  requestId: z.string().min(1),
  issues: z.array(contentReviewIssueSchema).max(LLM_LIMITS.maxIssues),
  model: z.string().max(200),
  usage: z.object({ inputTokens: tokenCount, outputTokens: tokenCount }),
});

export const pythonErrorBodySchema = z.object({
  error: z.object({
    code: z.string().max(100),
    message: z.string().max(1000).optional(),
  }),
});
