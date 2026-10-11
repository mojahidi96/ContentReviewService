import type {
  ContentReviewRequest,
  ContentReviewResponse,
  LlmHealth,
  ModelCatalog,
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
  /** Models the author may choose from, as allowed by the Python service. */
  listModels(options?: { signal?: AbortSignal }): Promise<ModelCatalog>;
  checkHealth(): Promise<LlmHealth>;
  close(): Promise<void>;
}
