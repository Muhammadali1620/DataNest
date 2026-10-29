// Bridges event-emitter producers (driver protocols) to async iteration.
// Single consumer; the producer learns about a stopped consumer from push().

interface Waiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: unknown): void;
}

/**
 * Back-pressure: once `highWater` items wait unread, the producer is asked to pause,
 * and to resume when the consumer has read the buffer down to half of that.
 */
export interface FlowControl {
  readonly highWater: number;
  readonly pause: () => void;
  readonly resume: () => void;
}

/**
 * A FIFO queue that one consumer reads with `for await`, unbounded unless it is
 * given flow control. After `end()` or `fail()` the remaining buffered items are
 * still delivered; when the consumer stops early, the buffer is dropped and `push`
 * returns false.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiter: Waiter<T> | undefined;
  private ended = false;
  private failure: { error: unknown } | undefined;
  private closed = false;
  private paused = false;

  constructor(private readonly flow?: FlowControl) {}

  /** True while the producer has been asked to wait for the consumer. */
  get isPaused(): boolean {
    return this.paused;
  }

  /** True when nothing more will reach the consumer: it stopped, or the queue ended and drained. */
  get isClosed(): boolean {
    return this.closed || (this.buffer.length === 0 && (this.ended || this.failure !== undefined));
  }

  /** Adds an item; returns false (and drops it) when the consumer no longer listens. */
  push(item: T): boolean {
    if (this.closed || this.ended || this.failure) {
      return false;
    }
    if (this.waiter) {
      const waiter = this.waiter;
      this.waiter = undefined;
      waiter.resolve({ value: item, done: false });
    } else {
      this.buffer.push(item);
      if (this.flow !== undefined && !this.paused && this.buffer.length >= this.flow.highWater) {
        this.paused = true;
        this.flow.pause();
      }
    }
    return true;
  }

  /** The consumer read an item: the producer may go on once half the buffer is gone. */
  private drained(): void {
    if (this.paused && this.flow !== undefined && this.buffer.length <= this.flow.highWater / 2) {
      this.release();
    }
  }

  private release(): void {
    if (this.paused) {
      this.paused = false;
      this.flow?.resume();
    }
  }

  /** No more items; buffered ones are still delivered. Idempotent. */
  end(): void {
    if (this.ended || this.failure || this.closed) {
      return;
    }
    this.ended = true;
    if (this.waiter && this.buffer.length === 0) {
      const waiter = this.waiter;
      this.waiter = undefined;
      this.closed = true;
      waiter.resolve({ value: undefined, done: true });
    }
  }

  /** The consumer gets this error after the buffered items. Idempotent. */
  fail(error: unknown): void {
    if (this.ended || this.failure || this.closed) {
      return;
    }
    this.failure = { error };
    if (this.waiter && this.buffer.length === 0) {
      const waiter = this.waiter;
      this.waiter = undefined;
      this.closed = true;
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        if (this.buffer.length > 0) {
          // The cast is safe: length was just checked.
          const value = this.buffer.shift() as T;
          this.drained();
          return Promise.resolve({ value, done: false });
        }
        if (this.failure) {
          this.closed = true;
          const { error } = this.failure;
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        if (this.ended) {
          this.closed = true;
          return Promise.resolve({ value: undefined, done: true });
        }
        if (this.waiter) {
          return Promise.reject(new Error('AsyncQueue supports a single consumer'));
        }
        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      // `break` / `return` inside `for await` lands here: stop accepting items.
      return: (): Promise<IteratorResult<T>> => {
        this.closed = true;
        this.buffer = [];
        // A paused producer must run to its end, or its connection stays stuck.
        this.release();
        if (this.waiter) {
          const waiter = this.waiter;
          this.waiter = undefined;
          waiter.resolve({ value: undefined, done: true });
        }
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
