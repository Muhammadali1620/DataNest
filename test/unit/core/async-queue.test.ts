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
});
