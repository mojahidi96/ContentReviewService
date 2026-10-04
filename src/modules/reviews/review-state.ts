import type { FindingStatus } from './finding.schema.js';
import type { ReviewStatus } from './review.model.js';

const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  pending: ['processing', 'failed', 'cancelled'],
  // processing -> processing: a retry attempt re-claims the review.
  processing: ['processing', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

export const TERMINAL_REVIEW_STATUSES: readonly ReviewStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

export function isTerminalReviewStatus(status: ReviewStatus): boolean {
  return TERMINAL_REVIEW_STATUSES.includes(status);
}

export function canTransitionReview(from: ReviewStatus, to: ReviewStatus): boolean {
  return REVIEW_TRANSITIONS[from].includes(to);
}

/** Statuses from which a review may move to `to` (for use in conditional DB updates). */
export function reviewSourcesFor(to: ReviewStatus): ReviewStatus[] {
  return (Object.keys(REVIEW_TRANSITIONS) as ReviewStatus[]).filter((from) =>
    REVIEW_TRANSITIONS[from].includes(to),
  );
}

/** Statuses a user may set on a finding. `resolved` is reserved for system use. */
export const USER_FINDING_ACTIONS = ['accepted', 'dismissed'] as const;
export type UserFindingAction = (typeof USER_FINDING_ACTIONS)[number];

const FINDING_TRANSITIONS: Record<FindingStatus, readonly FindingStatus[]> = {
  pending: ['accepted', 'dismissed', 'resolved'],
  // Users can change their mind between accepting and dismissing.
  accepted: ['dismissed', 'resolved'],
  dismissed: ['accepted', 'resolved'],
  resolved: [],
};

export function canTransitionFinding(from: FindingStatus, to: FindingStatus): boolean {
  return FINDING_TRANSITIONS[from].includes(to);
}
