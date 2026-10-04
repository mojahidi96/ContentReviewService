import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { EventBus } from '../../infrastructure/events/event-bus.js';
import {
  formatComment,
  formatEvent,
  openEventStream,
  type SseRegistry,
} from '../../infrastructure/events/sse.js';
import type { MetricsRecorder } from '../../infrastructure/metrics/metrics.js';
import { getAuth } from '../../middleware/authenticate.js';
import { validateRequest } from '../../middleware/validate-request.js';
import { AppError } from '../../shared/errors/app-error.js';
import type { ReviewEventStore } from './review-event-store.js';
import { TERMINAL_EVENT_TYPES } from './review-events.js';
import { isTerminalReviewStatus } from './review-state.js';
import { reviewParamsSchema } from './review.schemas.js';
import type { ReviewService } from './review.service.js';

const BATCH_SIZE = 500;

const eventsQuerySchema = z.strictObject({
  // EventSource cannot set headers on the first connection; this lets a client resume
  // after a full page reload. The Last-Event-ID header (sent on auto-reconnect) wins.
  lastEventId: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
});

export function parseLastEventId(header: string | undefined): number | undefined {
  if (header === undefined || !/^\d{1,15}$/.test(header.trim())) return undefined;
  return Number(header.trim());
}

export function createReviewEventsHandler(deps: {
  env: Env;
  reviewService: ReviewService;
  events: ReviewEventStore;
  bus: EventBus;
  registry: SseRegistry;
  metrics: MetricsRecorder;
}): RequestHandler {
  const { env, reviewService, events, bus, registry, metrics } = deps;

  return validateRequest(
    { params: reviewParamsSchema, query: eventsQuerySchema },
    async (req, res, input) => {
      const { userId } = getAuth(req);
      const { reviewId } = input.params;
      let lastSeq = parseLastEventId(req.get('last-event-id')) ?? input.query.lastEventId ?? 0;

      // Ownership is checked before any stream bytes are written (404 for others' reviews).
      const status = await reviewService.getStatus(userId, reviewId);
      const pending = await events.listAfter(reviewId, lastSeq, BATCH_SIZE);
      if (isTerminalReviewStatus(status) && pending.length === 0) {
        // Nothing left to deliver. 204 tells EventSource to stop reconnecting.
        res.status(204).end();
        return;
      }

      openEventStream(res, env.SSE_RETRY_MS);
      const log = req.log.child({ reviewId });
      // Object (not a local boolean) because it is flipped asynchronously by `close`.
      const stream = { closed: false };
      let draining = false;
      let drainAgain = false;

      const close = () => {
        if (stream.closed) return;
        stream.closed = true;
        clearInterval(heartbeat);
        clearInterval(poller);
        unsubscribe();
        unregister();
        metrics.setActiveSseConnections(registry.size);
        res.end();
      };

      /** Writes events after lastSeq; returns true if the stream is (now) closed. */
      const writeBatch = (batch: Awaited<ReturnType<ReviewEventStore['listAfter']>>): boolean => {
        // The client may have disconnected while events were being read.
        if (stream.closed) return true;
        for (const event of batch) {
          res.write(formatEvent(event.id, event.type, event.data));
          lastSeq = event.id;
          if (TERMINAL_EVENT_TYPES.includes(event.type)) {
            close();
            return true;
          }
        }
        return false;
      };

      const drain = async (checkReview: boolean): Promise<void> => {
        if (stream.closed) return;
        if (draining) {
          drainAgain = true;
          return;
        }
        draining = true;
        try {
          do {
            drainAgain = false;
            const batch = await events.listAfter(reviewId, lastSeq, BATCH_SIZE);
            if (writeBatch(batch)) return;
            if (batch.length === BATCH_SIZE) drainAgain = true;
          } while (drainAgain);
          // Detect deletion (or ownership loss) while the stream is open.
          if (checkReview) await reviewService.getStatus(userId, reviewId);
        } catch (err) {
          if (!(err instanceof AppError)) log.warn({ err }, 'SSE drain failed; closing stream');
          close();
        } finally {
          draining = false;
        }
      };

      const heartbeat = setInterval(() => {
        if (!stream.closed) res.write(formatComment('heartbeat'));
      }, env.SSE_HEARTBEAT_MS);
      // Polling makes delivery work across instances; the bus only lowers same-process latency.
      const poller = setInterval(() => void drain(true), env.SSE_POLL_INTERVAL_MS);
      const unsubscribe = bus.onReview(reviewId, () => void drain(false));
      const unregister = registry.add(close);
      req.on('close', close);
      metrics.setActiveSseConnections(registry.size);

      if (!writeBatch(pending)) await drain(false);
    },
  );
}
