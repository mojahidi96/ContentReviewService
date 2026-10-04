import jwt from 'jsonwebtoken';

export interface SessionTokenClaims {
  userId: string;
  sessionId: string;
}

export interface JwtConfig {
  secret: string;
  issuer: string;
  audience: string;
  ttlSeconds: number;
}

export function signSessionToken(claims: SessionTokenClaims, config: JwtConfig): string {
  return jwt.sign({}, config.secret, {
    algorithm: 'HS256',
    subject: claims.userId,
    jwtid: claims.sessionId,
    issuer: config.issuer,
    audience: config.audience,
    expiresIn: config.ttlSeconds,
  });
}

/** Returns the claims of a valid token, or null for any invalid/expired/tampered token. */
export function verifySessionToken(token: string, config: JwtConfig): SessionTokenClaims | null {
  try {
    const payload = jwt.verify(token, config.secret, {
      algorithms: ['HS256'],
      issuer: config.issuer,
      audience: config.audience,
    });
    if (typeof payload === 'string' || !payload.sub || !payload.jti) return null;
    return { userId: payload.sub, sessionId: payload.jti };
  } catch {
    return null;
  }
}
