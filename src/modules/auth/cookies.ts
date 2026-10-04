import type { CookieOptions } from 'express';
import type { Env } from '../../config/env.js';

/** The session cookie is only sent to API routes. */
export const SESSION_COOKIE_PATH = '/api';

/** Anonymous identifier that binds pre-login CSRF tokens to a browser. */
export const ANON_COOKIE_SUFFIX = '_anon';
export const ANON_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type CookieEnv = Pick<
  Env,
  'AUTH_COOKIE_NAME' | 'AUTH_COOKIE_SECURE' | 'AUTH_COOKIE_SAMESITE' | 'AUTH_TOKEN_TTL'
>;

export function sessionCookieOptions(env: CookieEnv): CookieOptions {
  return {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    path: SESSION_COOKIE_PATH,
    maxAge: env.AUTH_TOKEN_TTL * 1000,
  };
}

export function clearSessionCookieOptions(env: CookieEnv): CookieOptions {
  const { maxAge: _maxAge, ...rest } = sessionCookieOptions(env);
  return rest;
}

export function anonCookieName(env: Pick<Env, 'AUTH_COOKIE_NAME'>): string {
  return `${env.AUTH_COOKIE_NAME}${ANON_COOKIE_SUFFIX}`;
}

export function anonCookieOptions(env: CookieEnv): CookieOptions {
  return {
    httpOnly: true,
    secure: env.AUTH_COOKIE_SECURE,
    sameSite: env.AUTH_COOKIE_SAMESITE,
    path: SESSION_COOKIE_PATH,
    maxAge: ANON_COOKIE_MAX_AGE_MS,
  };
}
