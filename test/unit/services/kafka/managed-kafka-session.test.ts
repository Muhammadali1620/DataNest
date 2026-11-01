import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { KafkaSession } from '../../../../src/drivers/kafka-driver';
import { ManagedKafkaSession } from '../../../../src/services/kafka/managed-kafka-session';

function inner(overrides: Partial<KafkaSession> = {}): KafkaSession {
  return {
    server: { clusterId: 'c', brokers: 2 },
    listTopics: () => Promise.resolve([{ name: 'orders', internal: false }]),
    describeTopic: (name) => Promise.resolve({ name, partitions: [] }),
    readMessages: () => Promise.resolve([]),
    offsetsForTime: () => Promise.resolve(new Map([[0, '5']])),
    listGroups: () => Promise.resolve([]),
    groupLag: () => Promise.resolve([]),
    produce: () => Promise.resolve({ partition: 0, offset: '1' }),
    createTopic: () => Promise.resolve(),
    deleteTopic: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

describe('ManagedKafkaSession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes every call to the session', async () => {
    const calls: string[] = [];
    const managed = new ManagedKafkaSession(
      inner({
        describeTopic: (name) => {
          calls.push(`describe ${name}`);
          return Promise.resolve({ name, partitions: [] });
        },
        groupLag: (group) => {
          calls.push(`lag ${group}`);
          return Promise.resolve([]);
        },
        createTopic: (name, partitions, replication) => {
          calls.push(`create ${name} ${partitions} ${replication}`);
          return Promise.resolve();
        },
        deleteTopic: (name) => {
          calls.push(`delete ${name}`);
          return Promise.resolve();
        },
      }),
      { onLinkLost: () => undefined },
    );
    expect(managed.server).toEqual({ clusterId: 'c', brokers: 2 });
    expect(await managed.listTopics()).toHaveLength(1);
    await managed.describeTopic('t');
    await managed.groupLag('g');
    await managed.createTopic('n', 3, 1);
    await managed.deleteTopic('n');
    expect(await managed.readMessages({ topic: 't', partition: 0, count: 1, maxBytes: 1 })).toEqual(
      [],
    );
    expect(await managed.offsetsForTime('t', 1)).toEqual(new Map([[0, '5']]));
    expect(await managed.listGroups()).toEqual([]);
    expect(await managed.produce({ topic: 't', value: null })).toEqual({
      partition: 0,
      offset: '1',
    });
    expect(calls).toEqual(['describe t', 'lag g', 'create n 3 1', 'delete n']);
  });

  it('tells the manager when the link is lost, and only then', async () => {
    const lost: unknown[] = [];
    const failing = new ManagedKafkaSession(
      inner({
        listTopics: () => Promise.reject(new DbError('connection-failed', 'gone')),
        listGroups: () => Promise.reject(new DbError('permission-denied', 'no')),
      }),
      {
        onLinkLost: (error) => {
          lost.push(error);
        },
      },
    );
    await expect(failing.listTopics()).rejects.toMatchObject({ code: 'connection-failed' });
    expect(lost).toHaveLength(1);
    await expect(failing.listGroups()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(lost).toHaveLength(1);
  });

  it('turns any failure into a DbError', async () => {
    const managed = new ManagedKafkaSession(
      inner({ listGroups: () => Promise.reject(new Error('odd')) }),
      { onLinkLost: () => undefined },
    );
    await expect(managed.listGroups()).rejects.toBeInstanceOf(DbError);
  });

  it('lists the topics after a quiet spell, to keep the link alive', async () => {
    let pings = 0;
    const managed = new ManagedKafkaSession(
      inner({
        listTopics: () => {
          pings += 1;
          return Promise.resolve([]);
        },
      }),
      { onLinkLost: () => undefined, keepAliveMs: 1000 },
    );
    managed.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(3500);
    expect(pings).toBe(3);
    await managed.close();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pings).toBe(3);
  });

  it('does not ping when keep-alive is off, and a ping that fails reports the lost link', async () => {
    let pings = 0;
    const off = new ManagedKafkaSession(
      inner({
        listTopics: () => {
          pings += 1;
          return Promise.resolve([]);
        },
      }),
      { onLinkLost: () => undefined },
    );
    off.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pings).toBe(0);

    const lost: unknown[] = [];
    const dying = new ManagedKafkaSession(
      inner({ listTopics: () => Promise.reject(new DbError('connection-failed', 'gone')) }),
      {
        onLinkLost: (error) => {
          lost.push(error);
        },
        keepAliveMs: 500,
      },
    );
    dying.scheduleKeepAlive();
    await vi.advanceTimersByTimeAsync(600);
    expect(lost).toHaveLength(1);
    await dying.close();
  });

  it('does not ping while a call is running', async () => {
    let pings = 0;
    let release: () => void = () => undefined;
    const managed = new ManagedKafkaSession(
      inner({
        listTopics: () => {
          pings += 1;
          return Promise.resolve([]);
        },
        listGroups: () =>
          new Promise((resolve) => {
            release = () => {
              resolve([]);
            };
          }),
      }),
      { onLinkLost: () => undefined, keepAliveMs: 100 },
    );
    managed.scheduleKeepAlive();
    const pending = managed.listGroups();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pings).toBe(0);
    release();
    await pending;
    await vi.advanceTimersByTimeAsync(150);
    expect(pings).toBe(1);
    await managed.close();
  });

  it('runs its closing hook after the session closed, even when closing fails', async () => {
    const order: string[] = [];
    const managed = new ManagedKafkaSession(
      inner({
        close: () => {
          order.push('inner');
          return Promise.reject(new Error('boom'));
        },
      }),
      {
        onLinkLost: () => undefined,
        onClosed: () => {
          order.push('hook');
          return Promise.resolve();
        },
      },
    );
    await expect(managed.close()).rejects.toThrow('boom');
    expect(order).toEqual(['inner', 'hook']);
  });
});
