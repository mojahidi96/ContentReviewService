import { Agent, errors as undiciErrors, request, type Dispatcher } from 'undici';
import type { Logger } from '../../config/logger.js';
import type { PythonLlmClient } from './llm-client.js';
import {
  LlmAbortedError,
  LlmBadResponseError,
  LlmError,
  LlmRateLimitedError,
  LlmRejectedError,
  LlmTimeoutError,
  LlmUnavailableError,
} from './llm.errors.js';
import { analysisResponseSchema, pythonErrorBodySchema } from './llm.schemas.js';
import type { AnalysisChunk, AnalysisRequest, AnalyzeOptions, LlmHealth } from './llm.types.js';

export const ANALYZE_PATH = '/internal/v1/content-reviews';
export const HEALTH_PATH = '/internal/v1/health';
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export interface HttpPythonLlmClientOptions {
  baseUrl: string;
  serviceToken: string;
  timeoutMs: number;
  connectTimeoutMs: number;
  logger: Logger;
}

const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
]);

/** Parses Retry-After (seconds or HTTP date) into milliseconds, capped at 10 minutes. */
export function parseRetryAfter(
  value: string | string[] | undefined,
  now = Date.now(),
): number | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) return undefined;
  const cap = 10 * 60 * 1000;
  if (/^\d+$/.test(raw.trim())) return Math.min(Number(raw) * 1000, cap);
  const date = Date.parse(raw);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - now), cap);
}

export class HttpPythonLlmClient implements PythonLlmClient {
  private readonly agent: Agent;
  private readonly baseUrl: string;

  constructor(private readonly options: HttpPythonLlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.agent = new Agent({
      connect: { timeout: options.connectTimeoutMs },
      headersTimeout: options.timeoutMs,
      bodyTimeout: options.timeoutMs,
      keepAliveTimeout: 10_000,
    });
  }

  async *analyze(req: AnalysisRequest, opts: AnalyzeOptions = {}): AsyncIterable<AnalysisChunk> {
    const timeoutSignal = AbortSignal.timeout(this.options.timeoutMs);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeoutSignal]) : timeoutSignal;

    let response: Dispatcher.ResponseData;
    try {
      response = await request(`${this.baseUrl}${ANALYZE_PATH}`, {
        method: 'POST',
        dispatcher: this.agent,
        signal,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          authorization: `Bearer ${this.options.serviceToken}`,
          'idempotency-key': req.requestId,
          ...(opts.correlationId ? { 'x-request-id': opts.correlationId } : {}),
        },
        body: JSON.stringify({
          requestId: req.requestId,
          content: req.content,
          categories: req.categories,
          language: req.language,
        }),
      });
    } catch (err) {
      throw this.mapTransportError(err, opts.signal);
    }

    const text = await this.readBody(response, opts.signal);
    const status = response.statusCode;

    if (status >= 200 && status < 300) {
      yield this.parseSuccess(text, req.requestId);
      return;
    }
    throw this.mapStatusError(status, text, response.headers['retry-after']);
  }

  async checkHealth(): Promise<LlmHealth> {
    const started = performance.now();
    try {
      const res = await request(`${this.baseUrl}${HEALTH_PATH}`, {
        method: 'GET',
        dispatcher: this.agent,
        signal: AbortSignal.timeout(Math.min(this.options.timeoutMs, 3_000)),
        headers: { authorization: `Bearer ${this.options.serviceToken}` },
      });
      await res.body.dump();
      const ok = res.statusCode >= 200 && res.statusCode < 300;
      return { status: ok ? 'ok' : 'unavailable', latencyMs: performance.now() - started };
    } catch {
      return { status: 'unavailable', latencyMs: performance.now() - started };
    }
  }

  async close(): Promise<void> {
    await this.agent.close();
  }

  private async readBody(
    response: Dispatcher.ResponseData,
    callerSignal?: AbortSignal,
  ): Promise<string> {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
      response.body.destroy();
      throw new LlmBadResponseError('Python response exceeds size limit');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of response.body) {
        const buf = chunk as Buffer;
        size += buf.length;
        if (size > MAX_RESPONSE_BYTES) {
          response.body.destroy();
          throw new LlmBadResponseError('Python response exceeds size limit');
        }
        chunks.push(buf);
      }
    } catch (err) {
      if (err instanceof LlmError) throw err;
      throw this.mapTransportError(err, callerSignal);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private parseSuccess(text: string, requestId: string): AnalysisChunk {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new LlmBadResponseError('Python response is not valid JSON', { cause: err });
    }
    const parsed = analysisResponseSchema.safeParse(json);
    if (!parsed.success) {
      // Log only the paths/codes of the violations, never values (they may contain content).
      const violations = parsed.error.issues
        .slice(0, 10)
        .map((i) => `${i.path.join('.')}:${i.code}`);
      this.options.logger.warn({ violations }, 'Python response violated the contract');
      throw new LlmBadResponseError('Python response violated the contract');
    }
    if (parsed.data.requestId !== requestId) {
      throw new LlmBadResponseError('Python response requestId mismatch');
    }
    return { type: 'result', findings: parsed.data.findings, model: parsed.data.model };
  }

  private mapStatusError(
    status: number,
    text: string,
    retryAfter: string | string[] | undefined,
  ): LlmError {
    let upstreamCode: string | undefined;
    try {
      const parsed = pythonErrorBodySchema.safeParse(JSON.parse(text));
      if (parsed.success) upstreamCode = parsed.data.error.code;
    } catch {
      // Non-JSON error bodies are fine; the status code drives classification.
    }
    const detail = `Python service responded ${status}${upstreamCode ? ` (${upstreamCode})` : ''}`;

    if (status === 429) {
      const retryAfterMs = parseRetryAfter(retryAfter);
      return new LlmRateLimitedError(detail, retryAfterMs === undefined ? {} : { retryAfterMs });
    }
    if (status === 408 || status === 504) return new LlmTimeoutError(detail);
    if (status >= 500) {
      const retryAfterMs = parseRetryAfter(retryAfter);
      return new LlmUnavailableError(detail, retryAfterMs === undefined ? {} : { retryAfterMs });
    }
    return new LlmRejectedError(detail, status, upstreamCode);
  }

  private mapTransportError(err: unknown, callerSignal?: AbortSignal): LlmError {
    if (err instanceof LlmError) return err;
    if (callerSignal?.aborted)
      return new LlmAbortedError('Python request aborted by caller', { cause: err });

    const name = (err as { name?: string } | null)?.name;
    const code = (err as { code?: string } | null)?.code;
    if (
      name === 'TimeoutError' ||
      err instanceof undiciErrors.ConnectTimeoutError ||
      err instanceof undiciErrors.HeadersTimeoutError ||
      err instanceof undiciErrors.BodyTimeoutError
    ) {
      return new LlmTimeoutError('Python request timed out', { cause: err });
    }
    if (code && UNAVAILABLE_CODES.has(code)) {
      return new LlmUnavailableError(`Python service unreachable (${code})`, { cause: err });
    }
    const causeCode = (err as { cause?: { code?: string } } | null)?.cause?.code;
    if (causeCode && UNAVAILABLE_CODES.has(causeCode)) {
      return new LlmUnavailableError(`Python service unreachable (${causeCode})`, { cause: err });
    }
    return new LlmUnavailableError('Python request failed', { cause: err });
  }
}
