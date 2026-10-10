import type { Env } from './config/env.js';
import type { Logger } from './config/logger.js';
import { EventBus } from './infrastructure/events/event-bus.js';
import { SseRegistry } from './infrastructure/events/sse.js';
import { JobQueue } from './infrastructure/jobs/job-queue.js';
import { JobWorker } from './infrastructure/jobs/job-worker.js';
import { ReviewRecovery } from './infrastructure/jobs/review-recovery.js';
import type { Registry } from 'prom-client';
import { ReviewJobModel } from './infrastructure/jobs/job.model.js';
import { LoggingMetrics, type MetricsRecorder } from './infrastructure/metrics/metrics.js';
import { PrometheusMetrics } from './infrastructure/metrics/prometheus-metrics.js';
import { HttpPythonLlmClient } from './integrations/python-llm/http-llm-client.js';
import type { PythonLlmClient } from './integrations/python-llm/llm-client.js';
import { MockPythonLlmClient } from './integrations/python-llm/mock-llm-client.js';
import { createEmailService, type EmailService } from './infrastructure/email/email.service.js';
import { AuthService } from './modules/auth/auth.service.js';
import { OtpService } from './modules/auth/otp.service.js';
import { DocumentService } from './modules/documents/document.service.js';
import { ReviewEventStore } from './modules/reviews/review-event-store.js';
import { ReviewProcessor } from './modules/reviews/review.processor.js';
import { ReviewService } from './modules/reviews/review.service.js';

/** Composition root: every dependency is constructed here and injected (no module singletons). */
export interface Container {
  env: Env;
  logger: Logger;
  metrics: MetricsRecorder;
  /** Present when Prometheus metrics are enabled; served by the internal metrics server. */
  metricsRegistry: Registry | null;
  bus: EventBus;
  sseRegistry: SseRegistry;
  llmClient: PythonLlmClient;
  authService: AuthService;
  emailService: EmailService;
  otpService: OtpService;
  events: ReviewEventStore;
  jobQueue: JobQueue;
  processor: ReviewProcessor;
  recovery: ReviewRecovery;
  reviewService: ReviewService;
  documentService: DocumentService;
  worker: JobWorker;
  lifecycle: { shuttingDown: boolean };
}

export function createLlmClient(env: Env, logger: Logger): PythonLlmClient {
  if (env.PYTHON_LLM_MODE === 'mock') return new MockPythonLlmClient({ delayMs: 300 });
  return new HttpPythonLlmClient({
    baseUrl: env.AI_SERVICE_BASE_URL,
    serviceToken: env.INTERNAL_SERVICE_TOKEN,
    timeoutMs: env.PYTHON_LLM_TIMEOUT_MS,
    connectTimeoutMs: env.PYTHON_LLM_CONNECT_TIMEOUT_MS,
    logger: logger.child({ component: 'python-llm-client' }),
  });
}

export function createMetrics(env: Env, logger: Logger): MetricsRecorder {
  if (!env.METRICS_ENABLED) return new LoggingMetrics(logger.child({ component: 'metrics' }));
  return new PrometheusMetrics({ queueDepth: countJobsByStatus });
}

async function countJobsByStatus(): Promise<Record<string, number>> {
  const rows = await ReviewJobModel.aggregate<{ _id: string; count: number }>([
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const counts: Record<string, number> = { queued: 0, running: 0, succeeded: 0, failed: 0 };
  for (const row of rows) counts[row._id] = row.count;
  return counts;
}

export function createContainer(
  env: Env,
  logger: Logger,
  overrides: Partial<Pick<Container, 'llmClient' | 'metrics' | 'emailService'>> = {},
): Container {
  const metrics = overrides.metrics ?? createMetrics(env, logger);
  const bus = new EventBus();
  const llmClient = overrides.llmClient ?? createLlmClient(env, logger);
  const emailService = overrides.emailService ?? createEmailService(env);
  const events = new ReviewEventStore(bus);
  const jobQueue = new JobQueue(bus, {
    maxAttempts: env.JOB_MAX_ATTEMPTS,
    leaseMs: env.JOB_LEASE_MS,
  });
  const processor = new ReviewProcessor({
    llmClient,
    events,
    jobQueue,
    metrics,
    logger: logger.child({ component: 'review-processor' }),
    backoff: { baseMs: env.JOB_BACKOFF_BASE_MS, maxMs: env.JOB_BACKOFF_MAX_MS },
  });
  const recovery = new ReviewRecovery(
    { queue: jobQueue, processor, logger: logger.child({ component: 'review-recovery' }) },
    { orphanAgeMs: env.JOB_ORPHAN_AGE_MS },
  );
  const worker = new JobWorker(
    {
      queue: jobQueue,
      processor,
      recovery,
      bus,
      metrics,
      logger: logger.child({ component: 'job-worker' }),
    },
    {
      concurrency: env.JOB_CONCURRENCY,
      pollIntervalMs: env.JOB_POLL_INTERVAL_MS,
      leaseMs: env.JOB_LEASE_MS,
      recoveryIntervalMs: env.JOB_RECOVERY_INTERVAL_MS,
    },
  );

  return {
    env,
    logger,
    metrics,
    metricsRegistry: metrics instanceof PrometheusMetrics ? metrics.registry : null,
    bus,
    sseRegistry: new SseRegistry(),
    llmClient,
    authService: new AuthService(env),
    emailService,
    otpService: new OtpService(env, emailService, logger.child({ component: 'otp' })),
    events,
    jobQueue,
    processor,
    recovery,
    reviewService: new ReviewService({
      jobQueue,
      events,
      logger: logger.child({ component: 'review-service' }),
      retentionDays: env.REVIEW_RETENTION_DAYS,
    }),
    documentService: new DocumentService(),
    worker,
    lifecycle: { shuttingDown: false },
  };
}
