// The RabbitMQ page of V13.32 without an editor: the live graphs of a queue and the change of a
// user's password or tags.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_RABBIT_SAMPLES } from '../../../../src/shared/protocols/rabbitmq-object';
import {
  LIVE_INTERVAL_MS,
  RabbitObjectModel,
  type RabbitObjectModelDeps,
} from '../../../../src/vscode/panels/rabbitmq-object-model';
import { FakeRabbitSession } from '../../../helpers/fake-rabbitmq';

function orders(
  session: FakeRabbitSession,
): NonNullable<ReturnType<FakeRabbitSession['broker']['queue']>> {
  const found = session.broker.queue('/', 'orders');
  if (found === undefined) {
    throw new Error('the queue is missing');
  }
  return found;
}

function setup(over: Partial<RabbitObjectModelDeps> = {}) {
  const session = new FakeRabbitSession();
  session.server = { version: '3.13.7', clusterName: 'c', user: 'admin' };
  session.broker.addQueue({
    vhost: '/',
    name: 'orders',
    unacked: 2,
    rates: { publish: 4, deliver: 3, ack: 2 },
    messages: [
      { payload: Buffer.from('a') },
      { payload: Buffer.from('b') },
      { payload: Buffer.from('c') },
    ],
  });
  session.broker.users.push({ name: 'ann', tags: ['monitoring'], password: 'old' });
  const make = (kind: 'queue' | 'exchange' | 'vhost', name: string) =>
    new RabbitObjectModel({
      kind,
      vhost: '/',
      name,
      connectionName: 'Broker',
      readOnly: false,
      session: () => Promise.resolve(session),
      ...over,
    });
  return {
    session,
    queue: make('queue', 'orders'),
    exchange: make('exchange', ''),
    vhost: make('vhost', '/'),
  };
}

describe('the live graphs of a queue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-02T10:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows nothing until they start', async () => {
    const { queue } = setup();
    const state = await queue.refresh();
    expect(state.live).toBeUndefined();
    expect(queue.live).toBe(false);
  });

  it('reads the queue at once and then every interval, handing each state on', async () => {
    const { queue, session } = setup();
    const states: unknown[] = [];
    await queue.startLive(
      (state) => states.push(state.live),
      () => undefined,
    );
    expect(queue.live).toBe(true);
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual({
      on: true,
      samples: [
        {
          at: Date.parse('2026-11-02T10:00:00Z'),
          ready: 3,
          unacked: 2,
          publish: 4,
          deliver: 3,
          ack: 2,
        },
      ],
    });
    // The broker's rates and counts move between readings.
    orders(session).messages.push({ payload: Buffer.from('d') });
    orders(session).rates = { publish: 0.5 };
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);
    expect(states).toHaveLength(2);
    const live = states[1] as { on: boolean; samples: { ready: number; deliver: number }[] };
    expect(live.samples.map((one) => one.ready)).toEqual([3, 4]);
    // A rate the broker did not send (an idle queue) is a rate of zero.
    expect(live.samples.map((one) => one.deliver)).toEqual([3, 0]);
    queue.stopLive();
  });

  it('keeps the counts of the page current while it reads', async () => {
    const { queue, session } = setup();
    await queue.refresh();
    await queue.startLive(
      () => undefined,
      () => undefined,
    );
    orders(session).messages.length = 0;
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);
    expect(queue.state()).toMatchObject({ ready: 0, unacked: 2, total: 2 });
    queue.stopLive();
  });

  it('keeps what it read after a stop, and a new start begins a new graph', async () => {
    const { queue } = setup();
    const noop = (): undefined => undefined;
    await queue.startLive(noop, noop);
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);
    queue.stopLive();
    expect(queue.live).toBe(false);
    expect(queue.state().live).toMatchObject({ on: false });
    expect(queue.state().live?.samples).toHaveLength(2);
    // Nothing is read once it is stopped.
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS * 3);
    expect(queue.state().live?.samples).toHaveLength(2);
    await queue.startLive(noop, noop);
    expect(queue.state().live?.samples).toHaveLength(1);
    queue.stopLive();
  });

  it('starting twice does not run two timers', async () => {
    const { queue, session } = setup();
    const noop = (): undefined => undefined;
    await queue.startLive(noop, noop);
    await queue.startLive(noop, noop);
    session.calls.length = 0;
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);
    expect(session.calls.filter((call) => call === 'getQueue')).toHaveLength(1);
    queue.stopLive();
  });

  it('keeps at most the latest readings', async () => {
    const { queue } = setup();
    const noop = (): undefined => undefined;
    await queue.startLive(noop, noop, 10);
    await vi.advanceTimersByTimeAsync(10 * (MAX_RABBIT_SAMPLES + 30));
    queue.stopLive();
    const samples = queue.state().live?.samples ?? [];
    expect(samples).toHaveLength(MAX_RABBIT_SAMPLES);
    expect(samples.at(-1)?.at).toBeGreaterThan(samples[0]?.at ?? 0);
  });

  it('stops and tells when a reading fails', async () => {
    const { queue, session } = setup();
    const errors: unknown[] = [];
    await queue.startLive(
      () => undefined,
      (error) => errors.push(error),
    );
    session.failures.set('getQueue', new Error('the broker went away'));
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS);
    expect(errors).toHaveLength(1);
    expect(queue.live).toBe(false);
    // What was read before stays.
    expect(queue.state().live).toMatchObject({ on: false });
    expect(queue.state().live?.samples).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(LIVE_INTERVAL_MS * 2);
    expect(errors).toHaveLength(1);
  });

  it('tells at once when the first reading fails', async () => {
    const { queue, session } = setup();
    session.failures.set('getQueue', new Error('no broker'));
    const errors: unknown[] = [];
    await queue.startLive(
      () => undefined,
      (error) => errors.push(error),
    );
    expect(errors).toHaveLength(1);
    expect(queue.live).toBe(false);
    expect(queue.state().live).toBeUndefined();
  });

  it('skips a tick while the last reading is still under way', async () => {
    const { session } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = new RabbitObjectModel({
      kind: 'queue',
      vhost: '/',
      name: 'orders',
      connectionName: 'Broker',
      readOnly: false,
      session: async () => {
        await gate;
        return session;
      },
    });
    const noop = (): undefined => undefined;
    const started = slow.startLive(noop, noop, 10);
    await vi.advanceTimersByTimeAsync(100);
    release();
    await started;
    slow.stopLive();
    expect(session.calls.filter((call) => call === 'getQueue')).toHaveLength(1);
  });

  it('is for a queue only', async () => {
    const { exchange, vhost } = setup();
    const noop = (): undefined => undefined;
    await expect(exchange.startLive(noop, noop)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(vhost.startLive(noop, noop)).rejects.toMatchObject({ code: 'unsupported' });
    // Stopping what never started is harmless.
    exchange.stopLive();
  });

  it('is allowed on a read-only connection: it only reads', async () => {
    const { queue } = setup({ readOnly: true });
    const noop = (): undefined => undefined;
    await queue.startLive(noop, noop);
    expect(queue.live).toBe(true);
    queue.stopLive();
  });
});

describe('changing a user', () => {
  it('changes the tags, cleaned, and keeps the password', async () => {
    const { vhost, session } = setup();
    await vhost.updateUser('ann', { tags: [' management ', '', 'policymaker'] });
    expect(session.broker.users.find((u) => u.name === 'ann')).toMatchObject({
      tags: ['management', 'policymaker'],
      password: 'old',
    });
  });

  it('changes the password alone', async () => {
    const { vhost, session } = setup();
    const state = await vhost.updateUser('ann', { password: 'new' });
    expect(session.broker.users.find((u) => u.name === 'ann')).toMatchObject({
      tags: ['monitoring'],
      password: 'new',
    });
    // The page is read again after the change.
    expect(state.admin?.users.map((u) => u.name)).toContain('ann');
  });

  it('can take every tag away with an empty list', async () => {
    const { vhost, session } = setup();
    await vhost.updateUser('ann', { tags: [] });
    expect(session.broker.users.find((u) => u.name === 'ann')?.tags).toEqual([]);
  });

  it('wants something to change', async () => {
    const { vhost, session } = setup();
    session.calls.length = 0;
    await expect(vhost.updateUser('ann', {})).rejects.toMatchObject({ code: 'syntax' });
    await expect(vhost.updateUser('ann', { password: '' })).rejects.toMatchObject({
      code: 'syntax',
    });
    expect(session.calls).not.toContain('updateUser');
  });

  it('is refused on a read-only connection, and belongs to a host page only', async () => {
    const readOnly = setup({ readOnly: true });
    await expect(readOnly.vhost.updateUser('ann', { password: 'x' })).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(readOnly.session.calls).not.toContain('updateUser');
    const writable = setup();
    await expect(writable.queue.updateUser('ann', { password: 'x' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('passes on the broker’s refusal of an unknown user', async () => {
    const { vhost } = setup();
    await expect(vhost.updateUser('ghost', { password: 'x' })).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
