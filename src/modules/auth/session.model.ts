import { Schema, model, type InferSchemaType } from 'mongoose';

/**
 * Server-side session record. The JWT's `jti` is the session `_id`; a JWT is accepted only
 * while its session exists, which makes logout an immediate, server-enforced revocation.
 */
const sessionSchema = new Schema(
  {
    _id: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'sessions' },
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.index({ userId: 1 });

export type Session = InferSchemaType<typeof sessionSchema>;
export const SessionModel = model('Session', sessionSchema);
