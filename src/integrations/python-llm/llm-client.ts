import type {
  ContentReviewRequest,
  ContentReviewResponse,
  LlmHealth,
  ReviewContentOptions,
} from './llm.types.js';

/**
 * The only surface the review domain knows about the Python AI service.
 * Implementations must validate responses against the documented contract and throw
 * `LlmError` subclasses for every failure mode.
 */
export interface PythonLlmClient {
  reviewContent(
    request: ContentReviewRequest,
    options?: ReviewContentOptions,
  ): Promise<ContentReviewResponse>;
  checkHealth(): Promise<LlmHealth>;
  close(): Promise<void>;
}
