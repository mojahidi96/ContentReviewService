import { Schema, model, type InferSchemaType } from 'mongoose';

export const OTP_PURPOSES = ['login', 'reset'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];

/**
 * One active emailed code per (user, purpose). Only an HMAC of the code is stored. Documents
 * are removed on use, after too many failed attempts, and by the TTL index once expired.
 */
const otpSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, enum: OTP_PURPOSES, required: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, required: true, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: 'otp_codes' },
);

otpSchema.index({ userId: 1, purpose: 1 }, { unique: true });
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type OtpRecord = InferSchemaType<typeof otpSchema>;
export const OtpModel = model('OtpCode', otpSchema);
