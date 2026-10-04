import type { Logger } from '../../config/logger.js';
import type { ReviewProcessor } from '../../modules/reviews/review.processor.js';
import { ReviewModel } from '../../modules/reviews/review.model.js';
import { ErrorCode } from '../../shared/errors/error-codes.js';
import type { JobQueue } from './job-queue.js';

/**
 * Repairs reviews whose processing state drifted from the job queue, e.g. after a crash
 * between persisting a review and enqueuing its job. Idempotent and safe to run concurrently.
 * (Expired job leases need no sweep: `JobQueue.claim` re-claims them directly.)
 */
export class ReviewRecovery {
  constructor(
    private readonly deps: { queue: JobQueue; processor: ReviewProcessor; logger: Logger },
    private readonly options: { orphanAgeMs: number; batchSize?: number },
  ) {}

  async recoverOrphans(): Promise<{ requeued: number; failed: number }> {
    const cutoff = new Date(Date.now() - this.options.orphanAgeMs);
    const stale = await ReviewModel.find({
      status: { $in: ['pending', 'processing'] },
      updatedAt: { $lt: cutoff },
    })
      .select({ _id: 1 })
      .sort({ updatedAt: 1 })
      .limit(this.options.batchSize ?? 100)
      .lean();

    let requeued = 0;
    let failed = 0;
    for (const { _id } of stale) {
      const reviewId = _id.toString();
      const job = await this.deps.queue.findByReview(reviewId);
      if (!job) {
        if (await this.deps.queue.enqueue(reviewId)) requeued++;
      } else if (job.status === 'succeeded' || job.status === 'failed') {
        // The job finished but the review never reached a terminal state.
        await this.deps.processor.failReview(
          reviewId,
          null,
          ErrorCode.PROCESSING_TIMEOUT,
          'The review could not be completed.',
        );
        failed++;
      }
    }
    if (requeued + failed > 0) {
      this.deps.logger.warn({ requeued, failed }, 'Recovered orphaned reviews');
    }
    return { requeued, failed };
  }
}
