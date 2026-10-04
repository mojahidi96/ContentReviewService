import { Schema, model, type Types } from 'mongoose';
import { REVIEW_EVENT_TYPES, type ReviewEventType } from './review-events.js';

/**
 * Durable event log per review. `seq` is the SSE event id. `dedupeKey` makes appends
 * idempotent, so a retried or duplicated job never emits the same logical event twice.
 */
const reviewEventSchema = new Schema(
  {
    reviewId: { type: Schema.Types.ObjectId, ref: 'Review', required: true },
    seq: { type: Number, required: true, min: 1 },
    type: { type: String, enum: REVIEW_EVENT_TYPES, required: true },
    dedupeKey: { type: String, required: true },
    data: { type: Schema.Types.Mixed, required: true },
    expiresAt: { type: Date, default: null },
  },
  {
    timestamps: { createdAt: true, updatedAt: false },
    collection: 'review_events',
    minimize: false,
  },
);

reviewEventSchema.index({ reviewId: 1, seq: 1 }, { unique: true });
reviewEventSchema.index({ reviewId: 1, dedupeKey: 1 }, { unique: true });
reviewEventSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: 'date' } } },
);

export interface ReviewEventRecord {
  _id: Types.ObjectId;
  reviewId: Types.ObjectId;
  seq: number;
  type: ReviewEventType;
  dedupeKey: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

export const ReviewEventModel = model('ReviewEvent', reviewEventSchema);
