// Bridges event-emitter producers (driver protocols) to async iteration.
// Single consumer; the producer learns about a stopped consumer from push().

interface Waiter<T> {
  resolve(result: IteratorResult<T>): void;
  reject(error: unknown): void;
}

/**
 * An unbounded FIFO queue that one consumer reads with `for await`.
 * After `end()` or `fail()` the remaining buffered items are still delivered;
 * when the consumer stops early, the buffer is dropped and `push` returns false.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiter: Waiter<T> | undefined;
  private ended = false;
  private failure: { error: unknown } | undefined;
  private closed = false;

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
    }
    return true;
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
          return Promise.resolve({ value: this.buffer.shift() as T, done: false });
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
