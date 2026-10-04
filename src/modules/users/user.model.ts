import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 254,
    },
    // Excluded by default; only the login path selects it explicitly.
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, required: true, trim: true, minlength: 1, maxlength: 100 },
  },
  { timestamps: true, collection: 'users' },
);

userSchema.index({ email: 1 }, { unique: true });

export type User = InferSchemaType<typeof userSchema>;
export type UserDocument = HydratedDocument<User>;
export const UserModel = model('User', userSchema);
