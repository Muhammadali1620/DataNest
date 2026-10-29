import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { ManagedElasticSession } from '../../../../src/services/elasticsearch/managed-elastic-session';
import { FakeElasticSession, json } from '../../../helpers/fake-elastic';

describe('ManagedElasticSession (V7.8)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(answer?: ConstructorParameters<typeof FakeElasticSession>[0], keepAliveMs = 0) {
    const inner = new FakeElasticSession(answer);
    const lost: unknown[] = [];
    let closed = 0;
    const session = new ManagedElasticSession(inner, {
      onLinkLost: (error) => lost.push(error),
      onClosed: () => {
        closed += 1;
        return Promise.resolve();
      },
      keepAliveMs,
    });
    return { inner, session, lost, closed: () => closed };
  }

  it('passes requests through and shows who the server is', async () => {
    const { session, inner } = setup(() => json({ ok: true }));
    expect(session.server.version).toBe('8.19.6');
    expect((await session.request({ method: 'GET', path: '/x' })).status).toBe(200);
    expect(inner.requests).toEqual(['GET /x']);
  });

  it('reports a lost link once and fails the request, but not an HTTP error', async () => {
    const lostLink = setup(() => new DbError('connection-failed', 'reset'));
    await expect(lostLink.session.request({ method: 'GET', path: '/' })).rejects.toMatchObject({
      code: 'connection-failed',
    });
    expect(lostLink.lost).toHaveLength(1);
    const timeout = setup(() => new DbError('timeout', 'slow'));
    await expect(timeout.session.request({ method: 'GET', path: '/' })).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(timeout.lost).toHaveLength(0);
  });

  it('sends HEAD / after a quiet spell, and reports it failing', async () => {
    vi.useFakeTimers();
    const { session, inner } = setup(undefined, 1000);
    session.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(1000);
    expect(inner.requests).toEqual(['HEAD /']);
    const failing = setup(() => new DbError('connection-failed', 'gone'), 500);
    failing.session.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(500);
    expect(failing.lost).toHaveLength(1);
  });

  it('stops pinging and lets go of its tunnel when closed', async () => {
    vi.useFakeTimers();
    const { session, inner, closed } = setup(undefined, 500);
    session.scheduleKeepAlive();
    await session.close();
    await vi.advanceTimersByTimeAsync(2000);
    expect(inner.requests).toEqual([]);
    expect(inner.closed).toBe(true);
    expect(closed()).toBe(1);
  });
});
