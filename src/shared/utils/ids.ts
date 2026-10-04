import { Types } from 'mongoose';

const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/;

/** Strict check: only canonical 24-char lowercase hex strings are accepted as public IDs. */
export function isObjectIdString(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID_PATTERN.test(value);
}

export function toObjectId(value: string): Types.ObjectId {
  return new Types.ObjectId(value);
}
