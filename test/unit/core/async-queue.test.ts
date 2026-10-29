import { describe, expect, it } from 'vitest';
import { AsyncQueue } from '../../../src/core/async-queue';

async function collect<T>(queue: AsyncQueue<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of queue) {
    items.push(item);
  }
  return items;
}

describe('AsyncQueue', () => {
  it('delivers items pushed before iteration starts', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.end();
    expect(await collect(queue)).toEqual([1, 2]);
  });

  it('delivers items pushed while the consumer waits', async () => {
    const queue = new AsyncQueue<number>();
    const result = collect(queue);
    queue.push(1);
    await Promise.resolve();
    queue.push(2);
    queue.end();
    expect(await result).toEqual([1, 2]);
  });

  it('ends an empty queue immediately', async () => {
    const queue = new AsyncQueue<number>();
    queue.end();
    expect(await collect(queue)).toEqual([]);
  });

  it('wakes a waiting consumer on end', async () => {
    const queue = new AsyncQueue<number>();
    const result = collect(queue);
    await Promise.resolve();
    queue.end();
    expect(await result).toEqual([]);
  });

  it('delivers buffered items before a failure', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.fail(new Error('boom'));
    const items: number[] = [];
    await expect(async () => {
      for await (const item of queue) {
        items.push(item);
      }
    }).rejects.toThrow('boom');
    expect(items).toEqual([1]);
  });

  it('rejects a waiting consumer on fail', async () => {
    const queue = new AsyncQueue<number>();
    const result = collect(queue);
    await Promise.resolve();
    queue.fail(new Error('late'));
    await expect(result).rejects.toThrow('late');
  });

  it('push returns false after end, fail and consumer break', async () => {
    const ended = new AsyncQueue<number>();
    ended.end();
    expect(ended.push(1)).toBe(false);

    const failed = new AsyncQueue<number>();
    failed.fail(new Error('x'));
    expect(failed.push(1)).toBe(false);

    const abandoned = new AsyncQueue<number>();
    abandoned.push(1);
    abandoned.push(2);
    for await (const item of abandoned) {
      expect(item).toBe(1);
      break;
    }
    expect(abandoned.push(3)).toBe(false);
    expect(abandoned.isClosed).toBe(true);
  });

  it('end and fail are idempotent and ignored after the other', async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.end();
    queue.end();
    queue.fail(new Error('ignored'));
    expect(await collect(queue)).toEqual([1]);
  });

  it('a second concurrent next() is rejected', async () => {
    const queue = new AsyncQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const first = iterator.next();
    await expect(iterator.next()).rejects.toThrow('single consumer');
    queue.push(1);
    expect((await first).value).toBe(1);
  });

  it('iteration after close reports done', async () => {
    const queue = new AsyncQueue<number>();
    queue.end();
    expect(await collect(queue)).toEqual([]);
    expect(await collect(queue)).toEqual([]);
  });

  describe('flow control', () => {
    function controlled(highWater = 4): { queue: AsyncQueue<number>; calls: string[] } {
      const calls: string[] = [];
      const queue = new AsyncQueue<number>({
        highWater,
        pause: () => calls.push('pause'),
        resume: () => calls.push('resume'),
      });
      return { queue, calls };
    }

    it('asks the producer to pause once the buffer reaches the high-water mark', () => {
      const { queue, calls } = controlled(3);
      queue.push(1);
      queue.push(2);
      expect(calls).toEqual([]);
      queue.push(3);
      expect(calls).toEqual(['pause']);
      expect(queue.isPaused).toBe(true);
      // More items while paused (the protocol cannot stop mid-packet) are still kept.
      expect(queue.push(4)).toBe(true);
      expect(calls).toEqual(['pause']);
    });

    it('resumes once the consumer has read the buffer down to half', async () => {
      const { queue, calls } = controlled(4);
      for (const item of [1, 2, 3, 4, 5]) {
        queue.push(item);
      }
      const iterator = queue[Symbol.asyncIterator]();
      expect((await iterator.next()).value).toBe(1);
      expect((await iterator.next()).value).toBe(2);
      expect(calls).toEqual(['pause']);
      expect((await iterator.next()).value).toBe(3);
      expect(calls).toEqual(['pause', 'resume']);
      expect(queue.isPaused).toBe(false);
    });

    it('never pauses when the consumer keeps up', async () => {
      const { queue, calls } = controlled(2);
      const iterator = queue[Symbol.asyncIterator]();
      for (const item of [1, 2, 3, 4]) {
        const next = iterator.next();
        queue.push(item);
        expect((await next).value).toBe(item);
      }
      expect(calls).toEqual([]);
    });

    it('lets a paused producer go on when the consumer stops early', async () => {
      const { queue, calls } = controlled(2);
      queue.push(1);
      queue.push(2);
      for await (const _item of queue) {
        break;
      }
      expect(calls).toEqual(['pause', 'resume']);
      expect(queue.push(3)).toBe(false);
    });

    it('delivers everything in order across several pauses', async () => {
      const total = 50;
      let next = 0;
      let paused = false;
      let pauses = 0;
      const queue: AsyncQueue<number> = new AsyncQueue<number>({
        highWater: 3,
        pause: () => {
          paused = true;
          pauses += 1;
        },
        resume: () => {
          paused = false;
          setTimeout(pump, 0);
        },
      });
      // A producer that honours pause, like a socket does.
      function pump(): void {
        while (!paused && next < total) {
          queue.push(next);
          next += 1;
        }
        if (next === total) {
          queue.end();
        }
      }
      pump();
      const received: number[] = [];
      for await (const item of queue) {
        received.push(item);
      }
      expect(received).toEqual(Array.from({ length: total }, (_, index) => index));
      expect(pauses).toBeGreaterThan(5);
    });
  });
});
