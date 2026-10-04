import type { Logger } from '../../config/logger.js';

/**
 * Instrumentation hook points. The default implementation emits structured debug logs;
 * swap in a Prometheus/OpenTelemetry-backed implementation without touching callers.
 */
export interface MetricsRecorder {
  observeHttpRequest(data: {
    method: string;
    route: string;
    statusCode: number;
    durationMs: number;
  }): void;
  observeJob(data: {
    outcome: 'completed' | 'retry' | 'failed' | 'released';
    durationMs: number;
    attempt: number;
    errorCode?: string;
  }): void;
  observeLlmCall(data: {
    outcome: 'success' | 'error';
    durationMs: number;
    errorCode?: string;
  }): void;
  setActiveSseConnections(count: number): void;
}

export class LoggingMetrics implements MetricsRecorder {
  constructor(private readonly logger: Logger) {}

  observeHttpRequest(data: Parameters<MetricsRecorder['observeHttpRequest']>[0]): void {
    this.logger.debug({ metric: 'http_request', ...data });
  }
  observeJob(data: Parameters<MetricsRecorder['observeJob']>[0]): void {
    this.logger.info({ metric: 'review_job', ...data });
  }
  observeLlmCall(data: Parameters<MetricsRecorder['observeLlmCall']>[0]): void {
    this.logger.info({ metric: 'llm_call', ...data });
  }
  setActiveSseConnections(count: number): void {
    this.logger.debug({ metric: 'sse_connections', count });
  }
}

export class NoopMetrics implements MetricsRecorder {
  observeHttpRequest(): void {}
  observeJob(): void {}
  observeLlmCall(): void {}
  setActiveSseConnections(): void {}
}
