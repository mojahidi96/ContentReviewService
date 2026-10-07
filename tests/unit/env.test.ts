import { describe, expect, it } from 'vitest';
import { EnvValidationError, loadEnv, parseDurationSeconds } from '../../src/config/env.js';

const base = {
  MONGODB_URI: 'mongodb://localhost:27017/content_review',
  FRONTEND_ORIGIN: 'http://localhost:4200',
  AUTH_JWT_SECRET: 'a'.repeat(40),
  CSRF_SECRET: 'b'.repeat(40),
  INTERNAL_SERVICE_TOKEN: 'c'.repeat(32),
};

const prod = {
  ...base,
  NODE_ENV: 'production',
  FRONTEND_ORIGIN: 'https://app.example.com',
  AUTH_COOKIE_SECURE: 'true',
};

function issuesFor(env: Record<string, string>): string[] {
  try {
    loadEnv(env);
    return [];
  } catch (err) {
    expect(err).toBeInstanceOf(EnvValidationError);
    return (err as EnvValidationError).issues;
  }
}

describe('environment validation', () => {
  it('applies defaults to a minimal valid configuration', () => {
    const env = loadEnv(base);
    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      AUTH_TOKEN_TTL: 900,
      AUTH_COOKIE_SECURE: false,
      AUTH_COOKIE_SAMESITE: 'lax',
      FRONTEND_ORIGIN: ['http://localhost:4200'],
      PYTHON_LLM_TIMEOUT_MS: 60_000,
      JOB_LEASE_MS: 90_000, // timeout + 30s
      TRUST_PROXY: false,
    });
  });

  it('parses lists, durations, booleans and trust proxy settings', () => {
    const env = loadEnv({
      ...base,
      FRONTEND_ORIGIN: 'http://localhost:4200, https://app.example.com',
      AUTH_TOKEN_TTL: '2h',
      AUTH_COOKIE_SECURE: 'true',
      TRUST_PROXY: '1',
    });
    expect(env.FRONTEND_ORIGIN).toEqual(['http://localhost:4200', 'https://app.example.com']);
    expect(env.AUTH_TOKEN_TTL).toBe(7200);
    expect(env.AUTH_COOKIE_SECURE).toBe(true);
    expect(env.TRUST_PROXY).toBe(1);
  });

  it('fails fast on missing or weak secrets without echoing values', () => {
    const issues = issuesFor({ ...base, AUTH_JWT_SECRET: 'short-secret', CSRF_SECRET: '' });
    expect(issues.join('\n')).toMatch(/AUTH_JWT_SECRET/);
    expect(issues.join('\n')).toMatch(/CSRF_SECRET/);
    expect(issues.join('\n')).not.toContain('short-secret');
    expect(issuesFor({ ...base, MONGODB_URI: '' }).join()).toMatch(/MONGODB_URI/);
  });

  it('requires a service token in http mode but not in mock mode', () => {
    expect(issuesFor({ ...base, INTERNAL_SERVICE_TOKEN: '' }).join()).toMatch(
      /INTERNAL_SERVICE_TOKEN/,
    );
    expect(issuesFor({ ...base, INTERNAL_SERVICE_TOKEN: '', PYTHON_LLM_MODE: 'mock' })).toEqual([]);
  });

  it('rejects origins with paths or trailing slashes', () => {
    expect(issuesFor({ ...base, FRONTEND_ORIGIN: 'http://localhost:4200/' }).join()).toMatch(
      /FRONTEND_ORIGIN/,
    );
    expect(issuesFor({ ...base, FRONTEND_ORIGIN: 'not a url' }).join()).toMatch(/FRONTEND_ORIGIN/);
  });

  it('requires Secure cookies for SameSite=None', () => {
    expect(issuesFor({ ...base, AUTH_COOKIE_SAMESITE: 'none' }).join()).toMatch(/SameSite=None/);
  });

  it('accepts a hardened production configuration', () => {
    expect(issuesFor(prod)).toEqual([]);
  });

  it.each([
    ['insecure cookies', { AUTH_COOKIE_SECURE: 'false' }, /AUTH_COOKIE_SECURE/],
    ['mock LLM', { PYTHON_LLM_MODE: 'mock' }, /PYTHON_LLM_MODE/],
    [
      'placeholder secret',
      { AUTH_JWT_SECRET: 'replace_with_a_strong_random_secret' },
      /placeholder/,
    ],
    [
      'docker-compose dev secret',
      { CSRF_SECRET: 'dev-only-csrf-secret-change-me-0123456789abcdef' },
      /placeholder/,
    ],
    ['shared secrets', { CSRF_SECRET: 'a'.repeat(40) }, /must differ/],
    ['http origin', { FRONTEND_ORIGIN: 'http://app.example.com' }, /https/],
  ])('rejects production config with %s', (_name, override, pattern) => {
    expect(issuesFor({ ...prod, ...override }).join('\n')).toMatch(pattern);
  });

  it.each([
    ['900', 900],
    ['900s', 900],
    ['15m', 900],
    ['12h', 43_200],
    ['7d', 604_800],
    ['15x', null],
    ['', null],
  ])('parseDurationSeconds(%s) = %s', (input, expected) => {
    expect(parseDurationSeconds(input)).toBe(expected);
  });
});
