import type { Response } from 'express';

/** Writes SSE response headers. Must be called before any body bytes. */
export function openEventStream(res: Response, retryMs: number): void {
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, no-transform',
    Connection: 'keep-alive',
    // Disable response buffering in nginx-style reverse proxies.
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(`retry: ${retryMs}\n\n`);
}

/** Formats one SSE event. JSON never contains raw newlines, so a single data line is safe. */
export function formatEvent(id: number, type: string, data: unknown): string {
  return `id: ${id}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function formatComment(text: string): string {
  return `: ${text.replace(/[\r\n]/g, ' ')}\n\n`;
}

/** Tracks open streams so graceful shutdown can end them (clients then reconnect elsewhere). */
export class SseRegistry {
  private readonly streams = new Set<() => void>();

  add(close: () => void): () => void {
    this.streams.add(close);
    return () => this.streams.delete(close);
  }

  get size(): number {
    return this.streams.size;
  }

  closeAll(): void {
    for (const close of [...this.streams]) close();
    this.streams.clear();
  }
}
