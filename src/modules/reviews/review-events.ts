import type { FindingDto } from './review.dto.js';

export const REVIEW_EVENT_TYPES = [
  'review.started',
  'review.progress',
  'finding.detected',
  'review.completed',
  'review.failed',
] as const;
export type ReviewEventType = (typeof REVIEW_EVENT_TYPES)[number];

export const TERMINAL_EVENT_TYPES: readonly ReviewEventType[] = [
  'review.completed',
  'review.failed',
];

export type ProgressStage = 'queued' | 'analyzing' | 'validating' | 'persisting' | 'retrying';

/** SSE `data` payloads, documented in docs/api-contract.md. Every payload carries reviewId + occurredAt. */
export interface ReviewEventPayloads {
  'review.started': { reviewId: string; status: 'processing'; occurredAt: string };
  'review.progress': {
    reviewId: string;
    stage: ProgressStage;
    attempt: number;
    nextAttemptAt?: string;
    occurredAt: string;
  };
  'finding.detected': { reviewId: string; finding: FindingDto; occurredAt: string };
  'review.completed': {
    reviewId: string;
    status: 'completed';
    findingCount: number;
    completedAt: string;
    occurredAt: string;
  };
  'review.failed': {
    reviewId: string;
    status: 'failed';
    errorCode: string;
    errorMessage: string;
    occurredAt: string;
  };
}

export interface ReviewEvent<T extends ReviewEventType = ReviewEventType> {
  id: number;
  type: T;
  data: ReviewEventPayloads[T];
}
