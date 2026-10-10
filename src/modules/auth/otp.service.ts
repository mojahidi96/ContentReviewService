import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../config/logger.js';
import type { EmailService } from '../../infrastructure/email/email.service.js';
import { normalizeEmail, UserModel } from '../users/user.model.js';
import { OtpModel, type OtpPurpose } from './otp.model.js';

type OtpEnv = Pick<Env, 'OTP_TTL_SECONDS' | 'OTP_MAX_ATTEMPTS' | 'OTP_HMAC_SECRET'>;

/**
 * Emailed one-time codes. Stored as HMAC(secret, userId:purpose:code), compared in constant
 * time, single use, with a bounded number of failed attempts per code.
 */
export class OtpService {
  private readonly pending = new Set<Promise<void>>();

  constructor(
    private readonly env: OtpEnv,
    private readonly email: EmailService,
    private readonly logger: Logger,
  ) {}

  /**
   * Fire-and-forget: the caller has already responded with the same 202 for every email, so
   * lookup, storage and sending happen off the request path. Failures are logged, never thrown.
   */
  requestCode(email: string, purpose: OtpPurpose, log: Logger = this.logger): void {
    const task = this.issueAndSend(normalizeEmail(email), purpose, log)
      .catch((err: unknown) => {
        log.error({ err, purpose }, 'Failed to issue emailed code');
      })
      .finally(() => this.pending.delete(task));
    this.pending.add(task);
  }

  /** Resolves when all in-flight issue/send tasks have settled (tests and graceful shutdown). */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /**
   * Consumes a code. Returns the user's id on success and null for every failure (wrong,
   * expired, missing, exhausted or unknown email) so callers cannot tell the cases apart.
   */
  async consume(email: string, purpose: OtpPurpose, code: string): Promise<string | null> {
    const user = await UserModel.findOne({ email: normalizeEmail(email) }, { _id: 1 }).lean();
    if (!user) {
      // Same HMAC and comparison work as a real check.
      this.matches(
        this.hash('000000000000000000000000', purpose, '0000'),
        this.hash('x', purpose, code),
      );
      return null;
    }
    const userId = user._id.toString();

    // Reserve an attempt atomically before comparing, so parallel guesses cannot exceed the cap.
    const record = await OtpModel.findOneAndUpdate(
      {
        userId: user._id,
        purpose,
        expiresAt: { $gt: new Date() },
        attempts: { $lt: this.env.OTP_MAX_ATTEMPTS },
      },
      { $inc: { attempts: 1 } },
      { returnDocument: 'after' },
    ).lean();
    if (!record) {
      this.matches(this.hash(userId, purpose, '0000'), this.hash(userId, purpose, code));
      return null;
    }

    if (!this.matches(record.codeHash, this.hash(userId, purpose, code))) {
      if (record.attempts >= this.env.OTP_MAX_ATTEMPTS)
        await OtpModel.deleteOne({ _id: record._id });
      return null;
    }
    // Single use: only one concurrent request can delete the document.
    const deleted = await OtpModel.deleteOne({ _id: record._id, codeHash: record.codeHash });
    return deleted.deletedCount === 1 ? userId : null;
  }

  private async issueAndSend(email: string, purpose: OtpPurpose, log: Logger): Promise<void> {
    const user = await UserModel.findOne({ email }, { _id: 1, email: 1 }).lean();
    if (!user) {
      log.info({ purpose, outcome: 'no_account' }, 'Emailed code skipped');
      return;
    }
    const code = String(randomInt(0, 10_000)).padStart(4, '0');
    await OtpModel.findOneAndUpdate(
      { userId: user._id, purpose },
      {
        $set: {
          codeHash: this.hash(user._id.toString(), purpose, code),
          expiresAt: new Date(Date.now() + this.env.OTP_TTL_SECONDS * 1000),
          attempts: 0,
        },
      },
      { upsert: true },
    );
    try {
      await this.email.sendOtp({
        to: user.email,
        code,
        purpose,
        expiresInMinutes: Math.max(1, Math.ceil(this.env.OTP_TTL_SECONDS / 60)),
      });
      log.info({ purpose, outcome: 'sent' }, 'Emailed code sent');
    } catch (err) {
      // Never changes the HTTP response; the error is logged without the code.
      log.error({ err, purpose, outcome: 'send_failed' }, 'Emailed code could not be sent');
    }
  }

  private hash(userId: string, purpose: OtpPurpose, code: string): string {
    return createHmac('sha256', this.env.OTP_HMAC_SECRET)
      .update(`${userId}:${purpose}:${code}`)
      .digest('hex');
  }

  private matches(expectedHex: string, actualHex: string): boolean {
    const a = Buffer.from(expectedHex, 'hex');
    const b = Buffer.from(actualHex, 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}
