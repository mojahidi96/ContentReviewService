import type { Logger } from '../../config/logger.js';
import type { JobQueue } from '../../infrastructure/jobs/job-queue.js';
import { Errors } from '../../shared/errors/app-error.js';
import { sha256Hex } from '../../shared/utils/hash.js';
import { toObjectId } from '../../shared/utils/ids.js';
import { codePointLength } from '../../shared/utils/offsets.js';
import type { ReviewEventStore } from './review-event-store.js';
import { canTransitionFinding, type UserFindingAction } from './review-state.js';
import {
  eventsUrlFor,
  toFindingDto,
  toReviewDto,
  toReviewSummaryDto,
  type FindingDto,
  type ReviewDto,
  type ReviewSummaryDto,
  type ReviewSummaryRecord,
} from './review.dto.js';
import {
  ReviewModel,
  type FindingRecord,
  type ReviewRecord,
  type ReviewStatus,
} from './review.model.js';
import type { CreateReviewBody, ListReviewsQuery } from './review.schemas.js';

export interface CreatedReview {
  reviewId: string;
  status: ReviewStatus;
  eventsUrl: string;
  createdAt: string;
}

export interface ReviewPage {
  items: ReviewSummaryDto[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const SUMMARY_PROJECTION = {
  documentTitle: 1,
  status: 1,
  categories: 1,
  findingCount: 1,
  errorCode: 1,
  errorMessage: 1,
  createdAt: 1,
  updatedAt: 1,
  completedAt: 1,
} as const;

/** All queries are scoped by userId: a review owned by someone else is indistinguishable from a missing one. */
export class ReviewService {
  constructor(
    private readonly deps: {
      jobQueue: JobQueue;
      events: ReviewEventStore;
      logger: Logger;
      retentionDays: number;
    },
  ) {}

  async create(userId: string, input: CreateReviewBody): Promise<CreatedReview> {
    const { retentionDays } = this.deps;
    const review = await ReviewModel.create({
      userId: toObjectId(userId),
      documentTitle: input.documentTitle,
      content: input.content,
      contentHash: sha256Hex(input.content),
      contentLength: codePointLength(input.content),
      categories: input.categories,
      status: 'pending',
      expiresAt: retentionDays > 0 ? new Date(Date.now() + retentionDays * 86_400_000) : null,
    });
    const reviewId = review._id.toString();

    try {
      await this.deps.jobQueue.enqueue(reviewId);
    } catch (err) {
      // The review is durable; the recovery sweep will enqueue it. Do not fail the request.
      this.deps.logger.error(
        { err, reviewId },
        'Failed to enqueue review job; recovery will retry',
      );
    }

    return {
      reviewId,
      status: review.status,
      eventsUrl: eventsUrlFor(reviewId),
      createdAt: review.createdAt.toISOString(),
    };
  }

  async list(userId: string, query: ListReviewsQuery): Promise<ReviewPage> {
    const filter = {
      userId: toObjectId(userId),
      ...(query.status ? { status: query.status } : {}),
    };
    const [records, total] = await Promise.all([
      ReviewModel.find(filter)
        .select(SUMMARY_PROJECTION)
        .sort({ createdAt: -1, _id: -1 })
        .skip((query.page - 1) * query.limit)
        .limit(query.limit)
        .lean<ReviewSummaryRecord[]>(),
      ReviewModel.countDocuments(filter),
    ]);
    return {
      items: records.map(toReviewSummaryDto),
      page: query.page,
      limit: query.limit,
      total,
      totalPages: Math.ceil(total / query.limit),
    };
  }

  async get(userId: string, reviewId: string): Promise<ReviewDto> {
    return toReviewDto(await this.findOwned(userId, reviewId));
  }

  /** Lightweight ownership/status check used before opening an SSE stream. */
  async getStatus(userId: string, reviewId: string): Promise<ReviewStatus> {
    const review = await ReviewModel.findOne({
      _id: toObjectId(reviewId),
      userId: toObjectId(userId),
    })
      .select({ status: 1 })
      .lean<{ status: ReviewStatus }>();
    if (!review) throw Errors.reviewNotFound();
    return review.status;
  }

  async updateFinding(
    userId: string,
    reviewId: string,
    findingId: string,
    status: UserFindingAction,
  ): Promise<FindingDto> {
    const review = await this.findOwned(userId, reviewId);
    if (review.status !== 'completed') throw Errors.reviewNotCompleted();
    const finding = review.findings.find((f) => f.findingId === findingId);
    if (!finding) throw Errors.findingNotFound();
    if (finding.status === status) return toFindingDto(finding); // idempotent
    if (!canTransitionFinding(finding.status, status)) {
      throw Errors.invalidTransition(finding.status, status);
    }

    const now = new Date();
    // Conditional on the status we validated against, so concurrent updates cannot skip checks.
    const updated = await ReviewModel.findOneAndUpdate(
      {
        _id: review._id,
        userId: review.userId,
        findings: { $elemMatch: { findingId, status: finding.status } },
      },
      { $set: { 'findings.$.status': status, 'findings.$.updatedAt': now } },
      { returnDocument: 'after', projection: { findings: { $elemMatch: { findingId } } } },
    ).lean<{ findings: FindingRecord[] }>();
    const result = updated?.findings[0];
    if (!result) throw Errors.conflict();
    return toFindingDto(result);
  }

  async delete(userId: string, reviewId: string): Promise<void> {
    const res = await ReviewModel.deleteOne({
      _id: toObjectId(reviewId),
      userId: toObjectId(userId),
    });
    if (res.deletedCount === 0) throw Errors.reviewNotFound();
    // An in-flight job sees the review gone and stops; its conditional writes match nothing.
    await Promise.all([
      this.deps.events.deleteForReview(reviewId),
      this.deps.jobQueue.deleteForReview(reviewId),
    ]);
  }

  private async findOwned(userId: string, reviewId: string): Promise<ReviewRecord> {
    const review = await ReviewModel.findOne({
      _id: toObjectId(reviewId),
      userId: toObjectId(userId),
    }).lean<ReviewRecord>();
    if (!review) throw Errors.reviewNotFound();
    return review;
  }
}
