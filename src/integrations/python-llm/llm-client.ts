import type { AnalysisChunk, AnalysisRequest, AnalyzeOptions, LlmHealth } from './llm.types.js';

/**
 * The only surface the review domain knows about the Python LLM worker.
 * Implementations must validate responses against the documented contract and throw
 * `LlmError` subclasses for every failure mode.
 */
export interface PythonLlmClient {
  analyze(request: AnalysisRequest, options?: AnalyzeOptions): AsyncIterable<AnalysisChunk>;
  checkHealth(): Promise<LlmHealth>;
  close(): Promise<void>;
}
