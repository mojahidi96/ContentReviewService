import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import {
  FINDING_CATEGORIES,
  type FindingCategory,
} from '../../integrations/python-llm/llm.types.js';
import { findingSchema, type FindingStatus } from './finding.schema.js';

export const REVIEW_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

const reviewSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    documentTitle: { type: String, required: true, trim: true, maxlength: 200 },
    // Stored so the UI can render findings against the original text after a refresh.
    // Removed automatically after REVIEW_RETENTION_DAYS (see expiresAt) or on DELETE.
    content: { type: String, required: true },
    contentHash: { type: String, required: true },
    contentLength: { type: Number, required: true, min: 1 },
    categories: { type: [{ type: String, enum: FINDING_CATEGORIES }], required: true },
    status: { type: String, enum: REVIEW_STATUSES, default: 'pending', required: true },
    findings: { type: [findingSchema], default: [] },
    findingCount: { type: Number, default: 0 },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null },
    /** Monotonic counter used to assign SSE event ids. */
    eventSeq: { type: Number, default: 0 },
    /** Job attempt that currently owns processing; guards writes from stale workers. */
    jobAttempt: { type: Number, default: 0 },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: null },
  },
  { timestamps: true, collection: 'reviews' },
);

reviewSchema.index({ userId: 1, createdAt: -1, _id: -1 });
reviewSchema.index({ userId: 1, status: 1, createdAt: -1 });
reviewSchema.index({ status: 1, updatedAt: 1 });
reviewSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, partialFilterExpression: { expiresAt: { $type: 'date' } } },
);

export type Review = InferSchemaType<typeof reviewSchema>;
export const ReviewModel = model('Review', reviewSchema);

/** Plain shape of a persisted finding (as read with `.lean()`). */
export interface FindingRecord {
  findingId: string;
  category: FindingCategory;
  severity: 'low' | 'medium' | 'high';
  originalText: string;
  suggestedText: string;
  explanation: string;
  startOffset: number;
  endOffset: number;
  status: FindingStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReviewRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  documentTitle: string;
  content: string;
  contentHash: string;
  contentLength: number;
  categories: FindingCategory[];
  status: ReviewStatus;
  findings: FindingRecord[];
  findingCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  eventSeq: number;
  jobAttempt: number;
  startedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
