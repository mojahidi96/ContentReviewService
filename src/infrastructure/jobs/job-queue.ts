import { mongo } from 'mongoose';
import { toObjectId } from '../../shared/utils/ids.js';
import type { EventBus } from '../events/event-bus.js';
import { ReviewJobModel, type ReviewJobRecord } from './job.model.js';

export interface JobQueueOptions {
  maxAttempts: number;
  leaseMs: number;
}

/**
 * MongoDB-backed job queue. All state transitions are single-document atomic updates that are
 * conditional on the claiming worker's lease, so a worker that lost its lease cannot clobber
 * the job. Delivery is at-least-once; the processor is idempotent.
 */
export class JobQueue {
  constructor(
    private readonly bus: EventBus,
    private readonly options: JobQueueOptions,
  ) {}

  /** Idempotent: enqueuing a review that already has a job is a no-op. Returns true if created. */
  async enqueue(reviewId: string): Promise<boolean> {
    let created: boolean;
    try {
      const result = await ReviewJobModel.updateOne(
        { reviewId: toObjectId(reviewId) },
        {
          $setOnInsert: {
            status: 'queued',
            attempts: 0,
            maxAttempts: this.options.maxAttempts,
            runAfter: new Date(),
          },
        },
        { upsert: true },
      );
      created = result.upsertedCount === 1;
    } catch (err) {
      // Two concurrent upserts can race on the unique index; the loser is a duplicate.
      if (err instanceof mongo.MongoServerError && err.code === 11000) return false;
      throw err;
    }
    if (created) this.bus.notifyJobEnqueued();
    return created;
  }

  /**
   * Claims the next runnable job: a queued job whose runAfter has passed, or a running job
   * whose lease expired (its worker crashed or stalled). Increments `attempts`.
   */
  async claim(workerId: string): Promise<ReviewJobRecord | null> {
    const now = new Date();
    return ReviewJobModel.findOneAndUpdate(
      {
        $or: [
          { status: 'queued', runAfter: { $lte: now } },
          { status: 'running', lockedUntil: { $lt: now } },
        ],
      },
      {
        $set: {
          status: 'running',
          lockedBy: workerId,
          lockedUntil: new Date(now.getTime() + this.options.leaseMs),
        },
        $inc: { attempts: 1 },
      },
      { sort: { runAfter: 1 }, returnDocument: 'after' },
    ).lean<ReviewJobRecord>();
  }

  /** Extends the lease of a job this worker still owns. Returns false if ownership was lost. */
  async renewLease(job: ReviewJobRecord, workerId: string): Promise<boolean> {
    const res = await ReviewJobModel.updateOne(this.ownedBy(job, workerId), {
      $set: { lockedUntil: new Date(Date.now() + this.options.leaseMs) },
    });
    return res.matchedCount === 1;
  }

  async complete(job: ReviewJobRecord, workerId: string): Promise<void> {
    await ReviewJobModel.updateOne(this.ownedBy(job, workerId), {
      $set: { status: 'succeeded', lockedBy: null, lockedUntil: null, finishedAt: new Date() },
    });
  }

  async fail(job: ReviewJobRecord, workerId: string, errorCode: string): Promise<void> {
    await ReviewJobModel.updateOne(this.ownedBy(job, workerId), {
      $set: {
        status: 'failed',
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: errorCode,
        finishedAt: new Date(),
      },
    });
  }

  async retry(
    job: ReviewJobRecord,
    workerId: string,
    delayMs: number,
    errorCode: string,
  ): Promise<Date> {
    const runAfter = new Date(Date.now() + delayMs);
    await ReviewJobModel.updateOne(this.ownedBy(job, workerId), {
      $set: {
        status: 'queued',
        runAfter,
        lockedBy: null,
        lockedUntil: null,
        lastErrorCode: errorCode,
      },
    });
    return runAfter;
  }

  /** Returns a job to the queue without consuming an attempt (used on graceful shutdown). */
  async release(job: ReviewJobRecord, workerId: string): Promise<void> {
    await ReviewJobModel.updateOne(this.ownedBy(job, workerId), {
      $set: { status: 'queued', runAfter: new Date(), lockedBy: null, lockedUntil: null },
      $inc: { attempts: -1 },
    });
  }

  async findByReview(reviewId: string): Promise<ReviewJobRecord | null> {
    return ReviewJobModel.findOne({ reviewId: toObjectId(reviewId) }).lean<ReviewJobRecord>();
  }

  async deleteForReview(reviewId: string): Promise<void> {
    await ReviewJobModel.deleteOne({ reviewId: toObjectId(reviewId) });
  }

  private ownedBy(job: ReviewJobRecord, workerId: string) {
    return { _id: job._id, status: 'running' as const, lockedBy: workerId, attempts: job.attempts };
  }
}
