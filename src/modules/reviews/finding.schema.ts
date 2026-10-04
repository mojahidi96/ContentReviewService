import { Schema } from 'mongoose';
import { FINDING_CATEGORIES, FINDING_SEVERITIES } from '../../integrations/python-llm/llm.types.js';

export const FINDING_STATUSES = ['pending', 'accepted', 'dismissed', 'resolved'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Embedded in Review: findings are always read and written with their review. */
export const findingSchema = new Schema(
  {
    findingId: { type: String, required: true },
    category: { type: String, enum: FINDING_CATEGORIES, required: true },
    severity: { type: String, enum: FINDING_SEVERITIES, required: true },
    originalText: { type: String, required: true },
    suggestedText: { type: String, default: '' },
    explanation: { type: String, required: true },
    startOffset: { type: Number, required: true, min: 0 },
    endOffset: { type: Number, required: true, min: 1 },
    status: { type: String, enum: FINDING_STATUSES, default: 'pending', required: true },
    createdAt: { type: Date, required: true },
    updatedAt: { type: Date, required: true },
  },
  { _id: false },
);
