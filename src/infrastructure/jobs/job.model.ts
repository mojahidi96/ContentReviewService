import { Schema, model, type Types } from 'mongoose';

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * One durable job per review (unique reviewId => enqueue is idempotent).
 * A running job holds a lease (`lockedUntil`); if its worker dies, the lease expires and
 * another worker re-claims it.
 */
const reviewJobSchema = new Schema(
  {
    reviewId: { type: Schema.Types.ObjectId, ref: 'Review', required: true },
    status: { type: String, enum: JOB_STATUSES, default: 'queued', required: true },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, required: true, min: 1 },
    runAfter: { type: Date, required: true },
    lockedBy: { type: String, default: null },
    lockedUntil: { type: Date, default: null },
    lastErrorCode: { type: String, default: null },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'review_jobs' },
);

reviewJobSchema.index({ reviewId: 1 }, { unique: true });
reviewJobSchema.index({ status: 1, runAfter: 1 });
reviewJobSchema.index({ status: 1, lockedUntil: 1 });
// Finished jobs are only bookkeeping; drop them after a week.
reviewJobSchema.index(
  { finishedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { finishedAt: { $type: 'date' } } },
);

export interface ReviewJobRecord {
  _id: Types.ObjectId;
  reviewId: Types.ObjectId;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  runAfter: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
  lastErrorCode: string | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const ReviewJobModel = model('ReviewJob', reviewJobSchema);
