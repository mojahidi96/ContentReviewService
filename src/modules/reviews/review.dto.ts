import type { FindingRecord, ReviewRecord, ReviewStatus } from './review.model.js';

export interface FindingDto {
  findingId: string;
  category: FindingRecord['category'];
  severity: FindingRecord['severity'];
  originalText: string;
  suggestedText: string;
  explanation: string;
  startOffset: number;
  endOffset: number;
  status: FindingRecord['status'];
  createdAt: string;
  updatedAt: string;
}

export interface ReviewSummaryDto {
  reviewId: string;
  documentTitle: string;
  status: ReviewStatus;
  categories: ReviewRecord['categories'];
  findingCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ReviewDto extends ReviewSummaryDto {
  content: string;
  contentLength: number;
  findings: FindingDto[];
  eventsUrl: string;
}

export function eventsUrlFor(reviewId: string): string {
  return `/api/v1/reviews/${reviewId}/events`;
}

export function toFindingDto(f: FindingRecord): FindingDto {
  return {
    findingId: f.findingId,
    category: f.category,
    severity: f.severity,
    originalText: f.originalText,
    suggestedText: f.suggestedText,
    explanation: f.explanation,
    startOffset: f.startOffset,
    endOffset: f.endOffset,
    status: f.status,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

export type ReviewSummaryRecord = Pick<
  ReviewRecord,
  | '_id'
  | 'documentTitle'
  | 'status'
  | 'categories'
  | 'findingCount'
  | 'errorCode'
  | 'errorMessage'
  | 'createdAt'
  | 'updatedAt'
  | 'completedAt'
>;

export function toReviewSummaryDto(r: ReviewSummaryRecord): ReviewSummaryDto {
  return {
    reviewId: r._id.toString(),
    documentTitle: r.documentTitle,
    status: r.status,
    categories: r.categories,
    findingCount: r.findingCount,
    errorCode: r.errorCode,
    errorMessage: r.errorMessage,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  };
}

export function toReviewDto(r: ReviewRecord): ReviewDto {
  const reviewId = r._id.toString();
  return {
    ...toReviewSummaryDto(r),
    content: r.content,
    contentLength: r.contentLength,
    findings: r.findings.map(toFindingDto),
    eventsUrl: eventsUrlFor(reviewId),
  };
}
