import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { MetricsRecorder } from './metrics.js';

export interface PrometheusMetricsOptions {
  /** Collect process metrics (CPU, heap, GC, event-loop lag). Disable in tests. */
  defaultMetrics?: boolean;
  /** Read at scrape time; returns job counts keyed by status. */
  queueDepth?: () => Promise<Record<string, number>>;
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const LONG_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 20, 30, 60, 120, 300];

/**
 * Prometheus implementation of the metrics hooks. Each instance owns its own Registry, so
 * multiple containers (e.g. in tests) never collide on the global default registry.
 * Label values are bounded: routes are templates, outcomes and error codes are enums.
 */
export class PrometheusMetrics implements MetricsRecorder {
  readonly registry = new Registry();
  private readonly httpRequests: Counter<'method' | 'route' | 'status_code'>;
  private readonly httpDuration: Histogram<'method' | 'route' | 'status_code'>;
  private readonly jobs: Counter<'outcome'>;
  private readonly jobDuration: Histogram<'outcome'>;
  private readonly llmCalls: Counter<'outcome' | 'error_code'>;
  private readonly llmDuration: Histogram<'outcome'>;
  private readonly sseConnections: Gauge;

  constructor(options: PrometheusMetricsOptions = {}) {
    const registers = [this.registry];
    this.registry.setDefaultLabels({ service: 'content-review-service' });
    if (options.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry });

    this.httpRequests = new Counter({
      name: 'http_requests_total',
      help: 'HTTP requests by method, route template and status code',
      labelNames: ['method', 'route', 'status_code'],
      registers,
    });
    this.httpDuration = new Histogram({
      name: 'http_request_duration_seconds',
      help: 'HTTP request latency (for SSE: stream lifetime)',
      labelNames: ['method', 'route', 'status_code'],
      buckets: LATENCY_BUCKETS,
      registers,
    });
    this.jobs = new Counter({
      name: 'review_jobs_total',
      help: 'Review job attempts by outcome',
      labelNames: ['outcome'],
      registers,
    });
    this.jobDuration = new Histogram({
      name: 'review_job_duration_seconds',
      help: 'Duration of a review job attempt',
      labelNames: ['outcome'],
      buckets: LONG_BUCKETS,
      registers,
    });
    this.llmCalls = new Counter({
      name: 'llm_calls_total',
      help: 'Calls to the Python LLM service by outcome and error code',
      labelNames: ['outcome', 'error_code'],
      registers,
    });
    this.llmDuration = new Histogram({
      name: 'llm_call_duration_seconds',
      help: 'Latency of calls to the Python LLM service',
      labelNames: ['outcome'],
      buckets: LONG_BUCKETS,
      registers,
    });
    this.sseConnections = new Gauge({
      name: 'sse_active_connections',
      help: 'Open Server-Sent Events streams on this instance',
      registers,
    });

    const { queueDepth } = options;
    if (queueDepth) {
      new Gauge({
        name: 'review_jobs_queue',
        help: 'Review jobs by status (read from MongoDB at scrape time)',
        labelNames: ['status'],
        registers,
        async collect() {
          this.reset();
          try {
            const counts = await queueDepth();
            for (const [status, count] of Object.entries(counts)) this.set({ status }, count);
          } catch {
            // Leave the gauge empty rather than failing the whole scrape.
          }
        },
      });
    }
  }

  observeHttpRequest(data: Parameters<MetricsRecorder['observeHttpRequest']>[0]): void {
    const labels = {
      method: data.method,
      route: data.route,
      status_code: String(data.statusCode),
    };
    this.httpRequests.inc(labels);
    this.httpDuration.observe(labels, data.durationMs / 1000);
  }

  observeJob(data: Parameters<MetricsRecorder['observeJob']>[0]): void {
    this.jobs.inc({ outcome: data.outcome });
    this.jobDuration.observe({ outcome: data.outcome }, data.durationMs / 1000);
  }

  observeLlmCall(data: Parameters<MetricsRecorder['observeLlmCall']>[0]): void {
    this.llmCalls.inc({ outcome: data.outcome, error_code: data.errorCode ?? 'none' });
    this.llmDuration.observe({ outcome: data.outcome }, data.durationMs / 1000);
  }

  setActiveSseConnections(count: number): void {
    this.sseConnections.set(count);
  }
}
