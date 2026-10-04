/**
 * Request augmentation shared by the middleware stack.
 * This file contains only types; it is part of the program via tsconfig `include`.
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Correlation ID, set by the request-id middleware. */
      requestId: string;
      /** Present when the request carries a valid, unrevoked session cookie. */
      auth?: AuthContext;
    }
  }
}
