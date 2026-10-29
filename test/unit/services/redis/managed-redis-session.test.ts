import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { ManagedRedisSession } from '../../../../src/services/redis/managed-redis-session';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

describe('ManagedRedisSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes calls, pipelines and keyless commands through', async () => {
    const inner = new FakeRedisSession(() => bulk('v'), 'cluster', 0);
    const session = new ManagedRedisSession(inner, { onLinkLost: vi.fn() });
    expect(session.mode).toBe('cluster');
    expect(session.database).toBe(0);
    expect(await session.call(['GET', 'k'])).toEqual(bulk('v'));
    expect(
      await session.pipeline([
        ['GET', 'a'],
        ['GET', 'b'],
      ]),
    ).toHaveLength(2);
    expect(await session.onMasters(['DBSIZE'])).toEqual([bulk('v')]);
    expect(inner.calls).toEqual([['GET', 'k'], ['GET', 'a'], ['GET', 'b'], ['DBSIZE']]);
  });

  it('reports a lost link once per failure and passes the error on', async () => {
    const onLinkLost = vi.fn();
    const inner = new FakeRedisSession(() => new DbError('connection-failed', 'gone'));
    const session = new ManagedRedisSession(inner, { onLinkLost });
    await expect(session.call(['PING'])).rejects.toMatchObject({ code: 'connection-failed' });
    expect(onLinkLost).toHaveBeenCalledTimes(1);
  });

  it('does not report an error reply as a lost link', async () => {
    const onLinkLost = vi.fn();
    const inner = new FakeRedisSession(() => new DbError('constraint', 'WRONGTYPE'));
    const session = new ManagedRedisSession(inner, { onLinkLost });
    await expect(session.call(['INCR', 'k'])).rejects.toMatchObject({ code: 'constraint' });
    expect(onLinkLost).not.toHaveBeenCalled();
  });

  it('wraps a foreign error in a DbError', async () => {
    const inner = new FakeRedisSession(() => new Error('boom'));
    const session = new ManagedRedisSession(inner, { onLinkLost: vi.fn() });
    await expect(session.call(['PING'])).rejects.toMatchObject({
      name: 'DbError',
      code: 'internal',
    });
  });

  it('pings after a quiet spell, and again after each one', async () => {
    const inner = new FakeRedisSession(() => bulk('PONG'));
    const session = new ManagedRedisSession(inner, { onLinkLost: vi.fn(), keepAliveMs: 1000 });
    session.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(999);
    expect(inner.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(inner.calls).toEqual([['PING']]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(inner.calls).toEqual([['PING'], ['PING']]);
  });

  it('counts the quiet from the last call', async () => {
    const inner = new FakeRedisSession(() => bulk('x'));
    const session = new ManagedRedisSession(inner, { onLinkLost: vi.fn(), keepAliveMs: 1000 });
    session.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(800);
    await session.call(['GET', 'k']);
    await vi.advanceTimersByTimeAsync(800);
    expect(inner.calls).toEqual([['GET', 'k']]);
    await vi.advanceTimersByTimeAsync(200);
    expect(inner.calls).toEqual([['GET', 'k'], ['PING']]);
  });

  it('never pings without a keep-alive, or after close', async () => {
    const inner = new FakeRedisSession(() => bulk('PONG'));
    const quiet = new ManagedRedisSession(inner, { onLinkLost: vi.fn() });
    quiet.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(60_000);
    const closing = new ManagedRedisSession(inner, { onLinkLost: vi.fn(), keepAliveMs: 1000 });
    closing.scheduleKeepAlive();
    await closing.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(inner.calls).toEqual([]);
  });

  it('reports a dead link found by the ping', async () => {
    const onLinkLost = vi.fn();
    const inner = new FakeRedisSession(() => new DbError('connection-failed', 'reset'));
    const session = new ManagedRedisSession(inner, { onLinkLost, keepAliveMs: 1000 });
    session.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onLinkLost).toHaveBeenCalledTimes(1);
  });

  it('closes the inner session and then runs the closed hook, even when closing fails', async () => {
    const order: string[] = [];
    const inner = new FakeRedisSession();
    inner.close = () => {
      order.push('inner');
      return Promise.reject(new Error('already gone'));
    };
    const session = new ManagedRedisSession(inner, {
      onLinkLost: vi.fn(),
      onClosed: () => {
        order.push('hook');
        return Promise.resolve();
      },
    });
    await expect(session.close()).rejects.toThrow('already gone');
    expect(order).toEqual(['inner', 'hook']);
  });
});
