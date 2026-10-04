import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { Errors, type ErrorDetail } from '../shared/errors/app-error.js';

interface RequestSchemas {
  body?: z.ZodType;
  params?: z.ZodType;
  query?: z.ZodType;
}

type Infer<S, K extends keyof RequestSchemas> =
  S extends Record<K, infer T extends z.ZodType> ? z.output<T> : undefined;

export interface ValidatedInput<S extends RequestSchemas> {
  body: Infer<S, 'body'>;
  params: Infer<S, 'params'>;
  query: Infer<S, 'query'>;
}

export function zodIssuesToDetails(error: z.ZodError, prefix?: string): ErrorDetail[] {
  return error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].filter(Boolean).join('.'),
    message: issue.message,
  }));
}

/**
 * Validates body/params/query with Zod and hands the typed, parsed result to the handler.
 * Unknown body keys are rejected by the schemas themselves (strict objects).
 */
export function validateRequest<S extends RequestSchemas>(
  schemas: S,
  handler: (req: Request, res: Response, input: ValidatedInput<S>) => Promise<void> | void,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const details: ErrorDetail[] = [];
    const input: Record<string, unknown> = { body: undefined, params: undefined, query: undefined };

    for (const key of ['params', 'query', 'body'] as const) {
      const schema = schemas[key];
      if (!schema) continue;
      const result = schema.safeParse(req[key] ?? {});
      if (result.success) input[key] = result.data;
      else details.push(...zodIssuesToDetails(result.error, key));
    }

    if (details.length > 0) {
      next(Errors.validation(details));
      return;
    }
    await handler(req, res, input as unknown as ValidatedInput<S>);
  };
}
