import { randomUUID } from 'node:crypto';
import { mongo } from 'mongoose';
import type { Env } from '../../config/env.js';
import { Errors } from '../../shared/errors/app-error.js';
import { isObjectIdString } from '../../shared/utils/ids.js';
import { toUserDto, type UserDto } from '../users/user.dto.js';
import { normalizeEmail, UserModel } from '../users/user.model.js';
import { signSessionToken, verifySessionToken, type JwtConfig } from './jwt.js';
import { getDummyHash, hashPassword, verifyPassword } from './password.js';
import { SessionModel } from './session.model.js';
import type { AuthContext } from '../../shared/types/express.js';

export interface IssuedSession {
  user: UserDto;
  sessionId: string;
  token: string;
}

type AuthEnv = Pick<
  Env,
  'AUTH_JWT_SECRET' | 'AUTH_JWT_ISSUER' | 'AUTH_JWT_AUDIENCE' | 'AUTH_TOKEN_TTL' | 'BCRYPT_ROUNDS'
>;

export class AuthService {
  private readonly jwtConfig: JwtConfig;

  constructor(private readonly env: AuthEnv) {
    this.jwtConfig = {
      secret: env.AUTH_JWT_SECRET,
      issuer: env.AUTH_JWT_ISSUER,
      audience: env.AUTH_JWT_AUDIENCE,
      ttlSeconds: env.AUTH_TOKEN_TTL,
    };
  }

  async register(input: {
    email: string;
    password: string;
    displayName: string;
  }): Promise<IssuedSession> {
    const email = normalizeEmail(input.email);
    const passwordHash = await hashPassword(input.password, this.env.BCRYPT_ROUNDS);
    try {
      const user = await UserModel.create({ email, passwordHash, displayName: input.displayName });
      return await this.issueSession(toUserDto(user));
    } catch (err) {
      if (err instanceof mongo.MongoServerError && err.code === 11000) throw Errors.emailTaken();
      throw err;
    }
  }

  async login(input: { email: string; password: string }): Promise<IssuedSession> {
    const user = await UserModel.findOne({ email: normalizeEmail(input.email) })
      .select('+passwordHash')
      .lean();
    // Always run bcrypt so unknown emails and wrong passwords take the same time.
    const hash = user?.passwordHash ?? (await getDummyHash(this.env.BCRYPT_ROUNDS));
    const passwordMatches = await verifyPassword(input.password, hash);
    if (!user || !passwordMatches) throw Errors.invalidCredentials();
    return this.issueSession(toUserDto(user));
  }

  /** Starts a session for a user whose identity was already proven (e.g. by an emailed code). */
  async loginVerifiedUser(userId: string): Promise<IssuedSession> {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw Errors.otpInvalid();
    return this.issueSession(toUserDto(user));
  }

  /**
   * Sets a new password and revokes every existing session of the user. Sessions are rows in
   * the sessions collection, so deleting them is an immediate, server-enforced revocation.
   */
  async resetPassword(userId: string, newPassword: string): Promise<IssuedSession> {
    const passwordHash = await hashPassword(newPassword, this.env.BCRYPT_ROUNDS);
    const user = await UserModel.findByIdAndUpdate(userId, { $set: { passwordHash } }).lean();
    if (!user) throw Errors.otpInvalid();
    await SessionModel.deleteMany({ userId });
    return this.issueSession(toUserDto(user));
  }

  async logout(sessionId: string): Promise<void> {
    await SessionModel.deleteOne({ _id: sessionId });
  }

  async getUser(userId: string): Promise<UserDto> {
    const user = await UserModel.findById(userId).lean();
    if (!user) throw Errors.authRequired();
    return toUserDto(user);
  }

  /** Resolves a session cookie value into an auth context, or null if invalid or revoked. */
  async resolveSession(token: string): Promise<AuthContext | null> {
    const claims = verifySessionToken(token, this.jwtConfig);
    if (!claims || !isObjectIdString(claims.userId)) return null;
    const session = await SessionModel.exists({
      _id: claims.sessionId,
      userId: claims.userId,
      expiresAt: { $gt: new Date() },
    });
    return session ? { userId: claims.userId, sessionId: claims.sessionId } : null;
  }

  private async issueSession(user: UserDto): Promise<IssuedSession> {
    const sessionId = randomUUID();
    await SessionModel.create({
      _id: sessionId,
      userId: user.id,
      expiresAt: new Date(Date.now() + this.env.AUTH_TOKEN_TTL * 1000),
    });
    const token = signSessionToken({ userId: user.id, sessionId }, this.jwtConfig);
    return { user, sessionId, token };
  }
}
