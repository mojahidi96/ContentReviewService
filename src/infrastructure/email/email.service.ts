import nodemailer, { type Transporter } from 'nodemailer';
import type { Env } from '../../config/env.js';
import type { OtpPurpose } from '../../modules/auth/otp.model.js';

export interface SendOtpInput {
  to: string;
  code: string;
  purpose: OtpPurpose;
  expiresInMinutes: number;
}

export interface EmailService {
  sendOtp(input: SendOtpInput): Promise<void>;
}

export interface OtpMessage {
  subject: string;
  text: string;
  html: string;
}

/** Plain text and simple HTML; deliberately contains no links. */
export function buildOtpMessage(input: Omit<SendOtpInput, 'to'>): OtpMessage {
  const minutes = `${String(input.expiresInMinutes)} ${input.expiresInMinutes === 1 ? 'minute' : 'minutes'}`;
  const reset = input.purpose === 'reset';
  const subject = reset
    ? 'Your ContentReview password reset code'
    : 'Your ContentReview sign-in code';
  const lead = reset
    ? `Your ContentReview password reset code is ${input.code}.`
    : `Your ContentReview sign-in code is ${input.code}.`;
  const tail = `It expires in ${minutes}. If you didn't request it, ignore this email.`;
  return {
    subject,
    text: `${lead} ${tail}`,
    // The code is four digits; nothing here needs escaping.
    html: `<p>${lead.replace(input.code, `<strong>${input.code}</strong>`)}</p><p>${tail}</p>`,
  };
}

/** Development only: prints the message to stdout. Never use for real users. */
export class ConsoleEmailService implements EmailService {
  constructor(private readonly write: (line: string) => void = (l) => process.stdout.write(l)) {}

  sendOtp(input: SendOtpInput): Promise<void> {
    const message = buildOtpMessage(input);
    this.write(`[mail:console] to=${input.to} subject="${message.subject}" :: ${message.text}\n`);
    return Promise.resolve();
  }
}

export class SmtpEmailService implements EmailService {
  private readonly transport: Transporter;

  constructor(
    smtpUrl: string,
    private readonly from: string,
  ) {
    this.transport = nodemailer.createTransport(smtpUrl);
  }

  async sendOtp(input: SendOtpInput): Promise<void> {
    const message = buildOtpMessage(input);
    await this.transport.sendMail({
      from: this.from,
      to: input.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }
}

export function createEmailService(env: Pick<Env, 'MAIL_TRANSPORT' | 'SMTP_URL' | 'MAIL_FROM'>) {
  if (env.MAIL_TRANSPORT === 'smtp') return new SmtpEmailService(env.SMTP_URL, env.MAIL_FROM);
  return new ConsoleEmailService();
}
