import { Schema, model, type Types } from 'mongoose';

/**
 * An author's working document. `content` is stored exactly as received: no trimming, no
 * Unicode normalization and no line-ending conversion, so indentation, blank lines, tabs and
 * trailing spaces come back byte-for-byte.
 */
const documentSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, maxlength: 200 },
    // Not `required`: Mongoose treats '' as missing, and an empty document is valid.
    content: { type: String, default: '' },
    contentLength: { type: Number, required: true, min: 0 },
    /** Incremented on every update; clients send it back for optimistic concurrency. */
    version: { type: Number, required: true, default: 1, min: 1 },
  },
  { timestamps: true, collection: 'documents' },
);

documentSchema.index({ userId: 1, updatedAt: -1, _id: -1 });

export const DocumentModel = model('Document', documentSchema);

export interface DocumentRecord {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  title: string;
  content: string;
  contentLength: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
