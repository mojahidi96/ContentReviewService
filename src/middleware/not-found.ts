import type { NextFunction, Request, Response } from 'express';
import { Errors } from '../shared/errors/app-error.js';

export function notFound(_req: Request, _res: Response, next: NextFunction): void {
  next(Errors.notFound());
}
