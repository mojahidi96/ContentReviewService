import { EventEmitter } from 'node:events';

/**
 * In-process wake-up signals. These carry no data: MongoDB is the source of truth, and
 * listeners re-read persisted state when woken. Instances that do not share this process
 * fall back to polling, so correctness never depends on this bus.
 */
export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  notifyReview(reviewId: string): void {
    this.emitter.emit(`review:${reviewId}`);
  }

  onReview(reviewId: string, listener: () => void): () => void {
    const name = `review:${reviewId}`;
    this.emitter.on(name, listener);
    return () => this.emitter.off(name, listener);
  }

  notifyJobEnqueued(): void {
    this.emitter.emit('job:enqueued');
  }

  onJobEnqueued(listener: () => void): () => void {
    this.emitter.on('job:enqueued', listener);
    return () => this.emitter.off('job:enqueued', listener);
  }

  listenerCount(): number {
    return this.emitter.eventNames().reduce((sum, n) => sum + this.emitter.listenerCount(n), 0);
  }
}
