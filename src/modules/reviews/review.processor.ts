import type { Logger } from '../../config/logger.js';
import type { JobQueue } from '../../infrastructure/jobs/job-queue.js';
import type { ReviewJobRecord } from '../../infrastructure/jobs/job.model.js';
import type { MetricsRecorder } from '../../infrastructure/metrics/metrics.js';
import type { PythonLlmClient } from '../../integrations/python-llm/llm-client.js';
import { LlmError, shouldRetry } from '../../integrations/python-llm/llm.errors.js';
import type { ContentReviewResponse } from '../../integrations/python-llm/llm.types.js';
import { ErrorCode } from '../../shared/errors/error-codes.js';
import { computeBackoffMs } from '../../shared/utils/backoff.js';
import type { ReviewEventStore } from './review-event-store.js';
import { resolveIssues } from './review-findings.js';
import { isTerminalReviewStatus, reviewSourcesFor } from './review-state.js';
import { toFindingDto } from './review.dto.js';
import { ReviewModel, type FindingRecord, type ReviewRecord } from './review.model.js';

export type ProcessOutcome = 'completed' | 'failed' | 'retry' | 'released' | 'skipped';

export interface ReviewProcessorDeps {
  llmClient: PythonLlmClient;
  events: ReviewEventStore;
  jobQueue: JobQueue;
  metrics: MetricsRecorder;
  logger: Logger;
  backoff: { baseMs: number; maxMs: number };
  language?: string;
}

const GENERIC_FAILURE_MESSAGE = 'The review could not be completed.';

/**
 * Review lifecycle orchestration. Invariants:
 *  - State is persisted before the corresponding event is appended.
 *  - Every review write made while processing is conditional on `jobAttempt`, so a worker that
 *    lost its lease cannot overwrite a newer attempt's result.
 *  - Event appends are idempotent (dedupe keys), so re-running any step is safe.
 */
export class ReviewProcessor {
  constructor(private readonly deps: ReviewProcessorDeps) {}

  async process(
    job: ReviewJobRecord,
    workerId: string,
    signal: AbortSignal,
  ): Promise<ProcessOutcome> {
    const { jobQueue, events } = this.deps;
    const reviewId = job.reviewId.toString();
    const attempt = job.attempts;
    const log = this.deps.logger.child({ reviewId, jobId: job._id.toString(), attempt });

    const review = await ReviewModel.findById(job.reviewId).lean<ReviewRecord>();
    if (!review) {
      log.info('Review no longer exists; dropping job');
      await jobQueue.complete(job, workerId);
      return 'skipped';
    }
    if (isTerminalReviewStatus(review.status)) {
      // Duplicate delivery, or a crash after persisting but before publishing: make sure the
      // terminal events exist, then finish the job.
      await this.republishTerminalEvents(review);
      await jobQueue.complete(job, workerId);
      return 'skipped';
    }
    if (attempt > job.maxAttempts) {
      log.warn('Attempts exhausted after lease expiry');
      await this.failReview(reviewId, null, ErrorCode.PROCESSING_TIMEOUT, GENERIC_FAILURE_MESSAGE);
      await jobQueue.fail(job, workerId, ErrorCode.PROCESSING_TIMEOUT);
      return 'failed';
    }

    const claimed = await ReviewModel.updateOne(
      { _id: review._id, status: { $in: reviewSourcesFor('processing') } },
      {
        $set: {
          status: 'processing',
          jobAttempt: attempt,
          startedAt: review.startedAt ?? new Date(),
        },
      },
    );
    if (claimed.matchedCount === 0) {
      await jobQueue.complete(job, workerId);
      return 'skipped';
    }

    await events.append(reviewId, 'review.started', 'review.started', {
      reviewId,
      status: 'processing',
      occurredAt: new Date().toISOString(),
    });
    await this.progress(reviewId, 'analyzing', attempt);

    try {
      const result = await this.analyze(review, signal);
      await this.progress(reviewId, 'validating', attempt);
      const now = new Date();
      const { findings, notFound, approximate, duplicates } = resolveIssues(
        reviewId,
        review.content,
        result.issues,
        now,
      );
      // Counts only: never log content or issue text.
      if (notFound > 0 || approximate > 0 || duplicates > 0) {
        log.warn(
          { notFound, approximate, duplicates, accepted: findings.length },
          'Some issues could not be placed exactly',
        );
      }

      await this.progress(reviewId, 'persisting', attempt);
      const saved = await ReviewModel.updateOne(
        { _id: review._id, status: 'processing', jobAttempt: attempt },
        {
          $set: {
            status: 'completed',
            findings,
            findingCount: findings.length,
            completedAt: now,
            errorCode: null,
            errorMessage: null,
            errorDetails: null,
          },
        },
      );
      if (saved.matchedCount === 0) {
        log.warn('Lost ownership of review before persisting; discarding result');
        return 'skipped';
      }

      await this.publishCompletion(reviewId, findings, now);
      await jobQueue.complete(job, workerId);
      log.info(
        { findingCount: findings.length, model: result.model, usage: result.usage },
        'Review completed',
      );
      return 'completed';
    } catch (err) {
      if (signal.aborted) {
        log.info('Processing interrupted; releasing job');
        await jobQueue.release(job, workerId);
        return 'released';
      }
      return this.handleFailure(job, workerId, err, log);
    }
  }

  /** Marks a review failed (if not already terminal) and emits review.failed. */
  async failReview(
    reviewId: string,
    attempt: number | null,
    errorCode: string,
    errorMessage: string,
    errorDetails: Record<string, unknown> | null = null,
  ): Promise<void> {
    const filter: Record<string, unknown> = {
      _id: reviewId,
      status: { $in: reviewSourcesFor('failed') },
    };
    if (attempt !== null) filter.jobAttempt = attempt;
    await ReviewModel.updateOne(filter, {
      $set: { status: 'failed', errorCode, errorMessage, errorDetails },
    });

    const review = await ReviewModel.findById(reviewId).lean<ReviewRecord>();
    if (review?.status === 'failed') await this.republishTerminalEvents(review);
  }

  private async handleFailure(
    job: ReviewJobRecord,
    workerId: string,
    err: unknown,
    log: Logger,
  ): Promise<ProcessOutcome> {
    const reviewId = job.reviewId.toString();
    const attempt = job.attempts;
    const errorCode = err instanceof LlmError ? err.code : ErrorCode.PROCESSING_FAILED;

    if (shouldRetry(err, attempt, job.maxAttempts)) {
      const backoff = computeBackoffMs(attempt, this.deps.backoff);
      const retryAfter = err instanceof LlmError ? (err.retryAfterMs ?? 0) : 0;
      const delayMs = Math.max(backoff, retryAfter);
      log.warn({ errorCode, err: summarize(err), delayMs }, 'Review attempt failed; will retry');
      await this.progress(reviewId, 'retrying', attempt, new Date(Date.now() + delayMs));
      await this.deps.jobQueue.retry(job, workerId, delayMs, errorCode);
      return 'retry';
    }

    log.error({ errorCode, err: summarize(err) }, 'Review failed permanently');
    const message = err instanceof LlmError ? err.publicMessage : GENERIC_FAILURE_MESSAGE;
    const details = err instanceof LlmError ? (err.publicDetails ?? null) : null;
    await this.failReview(reviewId, attempt, errorCode, message, details);
    await this.deps.jobQueue.fail(job, workerId, errorCode);
    return 'failed';
  }

  private async analyze(review: ReviewRecord, signal: AbortSignal): Promise<ContentReviewResponse> {
    const started = performance.now();
    const reviewId = review._id.toString();
    try {
      const result = await this.deps.llmClient.reviewContent(
        {
          requestId: reviewId,
          content: review.content,
          ...(this.deps.language ? { language: this.deps.language } : {}),
          ...(review.model ? { model: review.model } : {}),
        },
        { signal, correlationId: reviewId },
      );
      this.deps.metrics.observeLlmCall({
        outcome: 'success',
        durationMs: performance.now() - started,
      });
      return result;
    } catch (err) {
      this.deps.metrics.observeLlmCall({
        outcome: 'error',
        durationMs: performance.now() - started,
        errorCode: err instanceof LlmError ? err.code : 'UNKNOWN',
      });
      throw err;
    }
  }

  private async publishCompletion(reviewId: string, findings: FindingRecord[], completedAt: Date) {
    const { events } = this.deps;
    for (const finding of findings) {
      await events.append(reviewId, 'finding.detected', `finding:${finding.findingId}`, {
        reviewId,
        finding: toFindingDto(finding),
        occurredAt: new Date().toISOString(),
      });
    }
    await events.append(reviewId, 'review.completed', 'review.completed', {
      reviewId,
      status: 'completed',
      findingCount: findings.length,
      completedAt: completedAt.toISOString(),
      occurredAt: new Date().toISOString(),
    });
  }

  private async republishTerminalEvents(review: ReviewRecord): Promise<void> {
    const reviewId = review._id.toString();
    if (review.status === 'completed') {
      await this.publishCompletion(
        reviewId,
        review.findings,
        review.completedAt ?? review.updatedAt,
      );
    } else if (review.status === 'failed') {
      await this.deps.events.append(reviewId, 'review.failed', 'review.failed', {
        reviewId,
        status: 'failed',
        errorCode: review.errorCode ?? ErrorCode.PROCESSING_FAILED,
        errorMessage: review.errorMessage ?? GENERIC_FAILURE_MESSAGE,
        ...(review.errorDetails ? { errorDetails: review.errorDetails } : {}),
        occurredAt: new Date().toISOString(),
      });
    }
  }

  private async progress(
    reviewId: string,
    stage: 'analyzing' | 'validating' | 'persisting' | 'retrying',
    attempt: number,
    nextAttemptAt?: Date,
  ): Promise<void> {
    await this.deps.events.append(reviewId, 'review.progress', `progress:${stage}:${attempt}`, {
      reviewId,
      stage,
      attempt,
      ...(nextAttemptAt ? { nextAttemptAt: nextAttemptAt.toISOString() } : {}),
      occurredAt: new Date().toISOString(),
    });
  }
}

/** Error summary for logs: class, message and code only (never request/response bodies). */
function summarize(err: unknown): { name: string; message: string; code?: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return { name: err.name, message: err.message, ...(typeof code === 'string' ? { code } : {}) };
  }
  return { name: 'NonError', message: String(err) };
}
