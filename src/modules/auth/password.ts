import bcrypt from 'bcryptjs';

export function hashPassword(password: string, rounds: number): Promise<string> {
  return bcrypt.hash(password, rounds);
}

export function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/**
 * A valid hash of an unguessable value. Comparing against it when the email is unknown keeps
 * the response time of a failed login roughly constant, so timing does not reveal accounts.
 */
let dummyHash: Promise<string> | undefined;
export function getDummyHash(rounds: number): Promise<string> {
  dummyHash ??= bcrypt.hash(`dummy-${String(Math.random())}`, rounds);
  return dummyHash;
}
