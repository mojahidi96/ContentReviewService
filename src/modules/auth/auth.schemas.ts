import { z } from 'zod';

const email = z
  .string()
  .trim()
  .max(254)
  .pipe(z.email({ message: 'Must be a valid email address' }));

export const registerBodySchema = z.strictObject({
  email,
  password: z
    .string()
    .min(12, 'Password must be at least 12 characters')
    // bcrypt only uses the first 72 bytes; cap well below that for multibyte safety.
    .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'Password must be at most 72 bytes'),
  displayName: z
    .string()
    .trim()
    .min(1, 'Display name is required')
    .max(100)
    .refine((s) => s.isWellFormed(), 'Display name contains invalid characters'),
});

export const loginBodySchema = z.strictObject({
  email,
  // No complexity rules here: login must not reveal password policy details per account.
  password: z.string().min(1).max(256),
});

export type RegisterBody = z.infer<typeof registerBodySchema>;
export type LoginBody = z.infer<typeof loginBodySchema>;
