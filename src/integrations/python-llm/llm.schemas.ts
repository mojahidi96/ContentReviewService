import { z } from 'zod';
import { FINDING_CATEGORIES, FINDING_SEVERITIES } from './llm.types.js';

/** Upper bounds that protect storage and the UI from runaway model output. */
export const LLM_LIMITS = {
  maxFindings: 1000,
  maxOriginalText: 10_000,
  maxSuggestedText: 10_000,
  maxExplanation: 2_000,
} as const;

const wellFormed = (s: string) => s.isWellFormed();

export const llmFindingSchema = z.object({
  category: z.enum(FINDING_CATEGORIES),
  severity: z.enum(FINDING_SEVERITIES),
  originalText: z.string().min(1).max(LLM_LIMITS.maxOriginalText).refine(wellFormed),
  suggestedText: z.string().max(LLM_LIMITS.maxSuggestedText).refine(wellFormed),
  explanation: z.string().min(1).max(LLM_LIMITS.maxExplanation).refine(wellFormed),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive(),
});

/**
 * Response of POST /internal/v1/content-reviews (contract v1).
 * Unknown fields are ignored (stripped) for forward compatibility; known fields are strict.
 */
export const analysisResponseSchema = z.object({
  requestId: z.string().min(1),
  offsetUnit: z.literal('codepoint'),
  model: z.string().max(200).optional(),
  findings: z.array(llmFindingSchema).max(LLM_LIMITS.maxFindings),
});

export const pythonErrorBodySchema = z.object({
  error: z.object({
    code: z.string().max(100),
    message: z.string().max(1000).optional(),
  }),
});

export type AnalysisResponse = z.infer<typeof analysisResponseSchema>;
