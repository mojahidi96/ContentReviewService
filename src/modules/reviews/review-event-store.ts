import { mongo } from 'mongoose';
import type { EventBus } from '../../infrastructure/events/event-bus.js';
import { toObjectId } from '../../shared/utils/ids.js';
import { ReviewEventModel, type ReviewEventRecord } from './review-events.model.js';
import type { ReviewEvent, ReviewEventPayloads, ReviewEventType } from './review-events.js';
import { ReviewModel } from './review.model.js';

export class ReviewEventStore {
  constructor(private readonly bus: EventBus) {}

  /**
   * Appends an event after the corresponding state has been persisted.
   * Idempotent per (reviewId, dedupeKey): returns the new seq, or null if the event already
   * existed or the review no longer exists.
   */
  async append<T extends ReviewEventType>(
    reviewId: string,
    type: T,
    dedupeKey: string,
    data: ReviewEventPayloads[T],
  ): Promise<number | null> {
    const id = toObjectId(reviewId);
    if (await ReviewEventModel.exists({ reviewId: id, dedupeKey })) return null;

    const review = await ReviewModel.findOneAndUpdate(
      { _id: id },
      { $inc: { eventSeq: 1 } },
      { returnDocument: 'after', projection: { eventSeq: 1, expiresAt: 1 } },
    ).lean();
    if (!review) return null;

    try {
      await ReviewEventModel.create({
        reviewId: id,
        seq: review.eventSeq,
        type,
        dedupeKey,
        data,
        expiresAt: review.expiresAt,
      });
    } catch (err) {
      // A concurrent append with the same dedupeKey won; the consumed seq is simply skipped.
      if (err instanceof mongo.MongoServerError && err.code === 11000) return null;
      throw err;
    }
    this.bus.notifyReview(reviewId);
    return review.eventSeq;
  }

  async listAfter(reviewId: string, afterSeq: number, limit = 500): Promise<ReviewEvent[]> {
    const records = await ReviewEventModel.find({
      reviewId: toObjectId(reviewId),
      seq: { $gt: afterSeq },
    })
      .sort({ seq: 1 })
      .limit(limit)
      .lean<ReviewEventRecord[]>();
    return records.map((r) => ({
      id: r.seq,
      type: r.type,
      data: r.data as unknown as ReviewEventPayloads[ReviewEventType],
    }));
  }

  async deleteForReview(reviewId: string): Promise<void> {
    await ReviewEventModel.deleteMany({ reviewId: toObjectId(reviewId) });
  }
}
