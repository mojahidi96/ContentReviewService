import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import type { Logger } from '../../config/logger.js';
import type { ReviewProcessor } from '../../modules/reviews/review.processor.js';
import { sleep } from '../../shared/utils/backoff.js';
import type { EventBus } from '../events/event-bus.js';
import type { MetricsRecorder } from '../metrics/metrics.js';
import { runWithContext } from '../observability/context.js';
import type { JobQueue } from './job-queue.js';
import type { ReviewJobRecord } from './job.model.js';
import type { ReviewRecovery } from './review-recovery.js';

export interface JobWorkerOptions {
  concurrency: number;
  pollIntervalMs: number;
  leaseMs: number;
  recoveryIntervalMs: number;
}

/**
 * Polls the durable queue with N concurrent slots. In-process enqueues wake idle slots
 * immediately; otherwise slots poll. Safe to run in several processes at once.
 */
export class JobWorker {
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private running = false;
  private stopController = new AbortController();
  private readonly slots: Promise<void>[] = [];
  private readonly inflight = new Map<string, AbortController>();
  private wakers = new Set<() => void>();
  private unsubscribe: (() => void) | undefined;
  private recoveryTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly deps: {
      queue: JobQueue;
      processor: ReviewProcessor;
      recovery: ReviewRecovery;
      bus: EventBus;
      metrics: MetricsRecorder;
      logger: Logger;
    },
    private readonly options: JobWorkerOptions,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.stopController = new AbortController();
    this.unsubscribe = this.deps.bus.onJobEnqueued(() => {
      this.wakeOne();
    });
    for (let i = 0; i < this.options.concurrency; i++) this.slots.push(this.runSlot());
    this.recoveryTimer = setInterval(
      () => void this.runRecovery(),
      this.options.recoveryIntervalMs,
    );
    this.recoveryTimer.unref();
    void this.runRecovery();
    this.deps.logger.info(
      { workerId: this.workerId, concurrency: this.options.concurrency },
      'Job worker started',
    );
  }

  /**
   * Stops claiming new jobs, waits up to `graceMs` for in-flight jobs, then aborts the rest
   * (they are released back to the queue without consuming an attempt).
   */
  async stop(graceMs: number): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.stopController.abort();
    this.unsubscribe?.();
    clearInterval(this.recoveryTimer);
    for (const wake of this.wakers) wake();

    const all = Promise.all(this.slots);
    const timedOut = await Promise.race([all.then(() => false), sleep(graceMs).then(() => true)]);
    if (timedOut) {
      for (const controller of this.inflight.values()) controller.abort();
      await all;
    }
    this.slots.length = 0;
    this.deps.logger.info({ workerId: this.workerId }, 'Job worker stopped');
  }

  /** Processes runnable jobs until the queue is empty (used by tests and one-shot tooling). */
  async drain(): Promise<number> {
    let processed = 0;
    for (;;) {
      const job = await this.deps.queue.claim(this.workerId);
      if (!job) return processed;
      await this.runJob(job);
      processed++;
    }
  }

  private async runSlot(): Promise<void> {
    while (this.running) {
      let job: ReviewJobRecord | null = null;
      try {
        job = await this.deps.queue.claim(this.workerId);
      } catch (err) {
        this.deps.logger.error({ err }, 'Failed to claim job');
      }
      if (job) await this.runJob(job);
      else await this.waitForWork();
    }
  }

  private waitForWork(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.wakers.delete(done);
        resolve();
      };
      const timer = setTimeout(done, this.options.pollIntervalMs);
      this.wakers.add(done);
    });
  }

  private wakeOne(): void {
    const first = this.wakers.values().next();
    if (!first.done) first.value();
  }

  private async runJob(job: ReviewJobRecord): Promise<void> {
    const key = `${job._id.toString()}:${job.attempts}`;
    const controller = new AbortController();
    this.inflight.set(key, controller);
    const started = performance.now();

    // Keep the lease alive while the job runs; abort if another worker took over.
    const renewer = setInterval(
      () => {
        this.deps.queue
          .renewLease(job, this.workerId)
          .then((owned) => {
            if (!owned) controller.abort();
          })
          .catch((err: unknown) => this.deps.logger.warn({ err }, 'Lease renewal failed'));
      },
      Math.max(1_000, Math.floor(this.options.leaseMs / 3)),
    );

    try {
      const outcome = await runWithContext(
        { reviewId: job.reviewId.toString(), jobId: job._id.toString(), attempt: job.attempts },
        () => this.deps.processor.process(job, this.workerId, controller.signal),
      );
      if (outcome !== 'skipped') {
        this.deps.metrics.observeJob({
          outcome,
          durationMs: performance.now() - started,
          attempt: job.attempts,
        });
      }
    } catch (err) {
      // Infrastructure failure inside the processor (e.g. DB down). The lease will expire and
      // the job will be re-claimed, consuming an attempt.
      this.deps.logger.error({ err, reviewId: job.reviewId.toString() }, 'Job processing crashed');
      this.deps.metrics.observeJob({
        outcome: 'failed',
        durationMs: performance.now() - started,
        attempt: job.attempts,
        errorCode: 'PROCESSOR_CRASH',
      });
    } finally {
      clearInterval(renewer);
      this.inflight.delete(key);
    }
  }

  private async runRecovery(): Promise<void> {
    try {
      await this.deps.recovery.recoverOrphans();
    } catch (err) {
      this.deps.logger.error({ err }, 'Review recovery sweep failed');
    }
  }
}
