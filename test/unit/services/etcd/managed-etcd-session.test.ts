import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { EtcdSession } from '../../../../src/drivers/etcd-driver';
import { ManagedEtcdSession } from '../../../../src/services/etcd/managed-etcd-session';

function inner(call: EtcdSession['call'] = () => Promise.resolve({})): EtcdSession & {
  closed: number;
} {
  const state = {
    closed: 0,
    server: { version: '3.5.17', clusterId: '1', dbSizeBytes: 0, authenticated: false },
    call,
    watch: () => Promise.resolve(),
    close: () => {
      state.closed += 1;
      return Promise.resolve();
    },
  };
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ManagedEtcdSession', () => {
  it('passes calls and the server info through', async () => {
    const call = vi.fn(() => Promise.resolve({ ok: true }));
    const session = new ManagedEtcdSession(inner(call), { onLinkLost: vi.fn() });
    expect(session.server.version).toBe('3.5.17');
    expect(await session.call('kv/range', { key: 'a' }, { timeoutMs: 5 })).toEqual({ ok: true });
    expect(call).toHaveBeenCalledWith('kv/range', { key: 'a' }, { timeoutMs: 5 });
  });

  it('tells the manager when the link is lost, and still throws', async () => {
    const lost = vi.fn();
    const session = new ManagedEtcdSession(
      inner(() => Promise.reject(new DbError('connection-failed', 'gone'))),
      { onLinkLost: lost },
    );
    await expect(session.call('kv/range', {})).rejects.toMatchObject({ code: 'connection-failed' });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('does not call a refusal a lost link', async () => {
    const lost = vi.fn();
    const session = new ManagedEtcdSession(
      inner(() => Promise.reject(new DbError('permission-denied', 'no'))),
      { onLinkLost: lost },
    );
    await expect(session.call('kv/range', {})).rejects.toMatchObject({ code: 'permission-denied' });
    expect(lost).not.toHaveBeenCalled();
  });

  it('wraps a plain error as an app error', async () => {
    const session = new ManagedEtcdSession(
      inner(() => Promise.reject(new Error('boom'))),
      { onLinkLost: vi.fn() },
    );
    await expect(session.call('kv/range', {})).rejects.toBeInstanceOf(DbError);
  });

  it('closes the session and then lets the manager tidy up, even when closing fails', async () => {
    const closed = vi.fn(() => Promise.resolve());
    const base = inner();
    base.close = () => Promise.reject(new Error('close failed'));
    const session = new ManagedEtcdSession(base, { onLinkLost: vi.fn(), onClosed: closed });
    await expect(session.close()).rejects.toThrow('close failed');
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('asks the cluster’s status after a quiet spell, and again after the next', async () => {
    const call = vi.fn(() => Promise.resolve({}));
    const session = new ManagedEtcdSession(inner(call), { onLinkLost: vi.fn(), keepAliveMs: 1000 });
    session.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(999);
    expect(call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(call).toHaveBeenCalledWith('maintenance/status', {});
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('postpones the ping while a call runs and after it', async () => {
    const call = vi.fn(() => Promise.resolve({}));
    const session = new ManagedEtcdSession(inner(call), { onLinkLost: vi.fn(), keepAliveMs: 1000 });
    session.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(900);
    await session.call('kv/range', {});
    call.mockClear();
    await vi.advanceTimersByTimeAsync(900);
    expect(call).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('reports a link the ping found dead', async () => {
    const lost = vi.fn();
    const session = new ManagedEtcdSession(
      inner(() => Promise.reject(new DbError('connection-failed', 'gone'))),
      { onLinkLost: lost, keepAliveMs: 500 },
    );
    session.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(600);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('never pings with no interval, and stops pinging once closed', async () => {
    const call = vi.fn(() => Promise.resolve({}));
    const quiet = new ManagedEtcdSession(inner(call), { onLinkLost: vi.fn() });
    quiet.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(call).not.toHaveBeenCalled();
    const closing = new ManagedEtcdSession(inner(call), { onLinkLost: vi.fn(), keepAliveMs: 100 });
    closing.scheduleKeepAlive();
    await closing.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(call).not.toHaveBeenCalled();
  });
});

describe('ManagedEtcdSession: watching', () => {
  it('hands the stream to the session below', async () => {
    const watch = vi.fn(() => Promise.resolve());
    const base = inner();
    base.watch = watch;
    const session = new ManagedEtcdSession(base, { onLinkLost: vi.fn() });
    const abort = new AbortController();
    const onMessage = vi.fn();
    await session.watch('watch', { a: 1 }, onMessage, abort.signal);
    expect(watch).toHaveBeenCalledWith('watch', { a: 1 }, onMessage, abort.signal);
  });

  it('tells the manager when the link is lost, and still throws', async () => {
    const lost = vi.fn();
    const base = inner();
    base.watch = () => Promise.reject(new DbError('connection-failed', 'gone'));
    const session = new ManagedEtcdSession(base, { onLinkLost: lost });
    await expect(
      session.watch('watch', {}, vi.fn(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'connection-failed' });
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('does not call a refusal a lost link, and wraps a plain error', async () => {
    const lost = vi.fn();
    const base = inner();
    base.watch = () => Promise.reject(new DbError('permission-denied', 'no'));
    const session = new ManagedEtcdSession(base, { onLinkLost: lost });
    await expect(
      session.watch('watch', {}, vi.fn(), new AbortController().signal),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    base.watch = () => Promise.reject(new Error('boom'));
    await expect(
      session.watch('watch', {}, vi.fn(), new AbortController().signal),
    ).rejects.toBeInstanceOf(DbError);
    expect(lost).not.toHaveBeenCalled();
  });

  it('is not quiet while the stream runs: no ping, and one when it ends', async () => {
    const call = vi.fn(() => Promise.resolve({}));
    const base = inner(call);
    let end: () => void = () => undefined;
    base.watch = () =>
      new Promise<void>((resolve) => {
        end = resolve;
      });
    const session = new ManagedEtcdSession(base, { onLinkLost: vi.fn(), keepAliveMs: 1000 });
    const running = session.watch('watch', {}, vi.fn(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(call).not.toHaveBeenCalled();
    end();
    await running;
    await vi.advanceTimersByTimeAsync(1100);
    expect(call).toHaveBeenCalledWith('maintenance/status', {});
  });
});
