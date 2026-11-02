import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { KafkaSession } from '../../../../src/drivers/kafka-driver';
import { ManagedKafkaSession } from '../../../../src/services/kafka/managed-kafka-session';

function inner(overrides: Partial<KafkaSession>): KafkaSession {
  const unused = (): never => {
    throw new Error('not used');
  };
  return {
    server: { clusterId: 'c', brokers: 1 },
    listTopics: () => Promise.resolve([]),
    describeTopic: unused,
    readMessages: unused,
    offsetsForTime: unused,
    watchMessages: unused,
    resetGroupOffsets: unused,
    listGroups: unused,
    groupLag: unused,
    produce: unused,
    createTopic: unused,
    deleteTopic: unused,
    close: () => Promise.resolve(),
    ...overrides,
  };
}

describe('ManagedKafkaSession: watching and resetting (V13.29)', () => {
  it('passes a watch through with its signal and its callback', async () => {
    const seen: string[] = [];
    const managed = new ManagedKafkaSession(
      inner({
        watchMessages: (request, onMessages) => {
          seen.push(`${request.topic}/${request.partition}`);
          onMessages([]);
          return Promise.resolve();
        },
      }),
      { onLinkLost: () => undefined },
    );
    let calls = 0;
    await managed.watchMessages(
      { topic: 't', partition: 2, signal: new AbortController().signal },
      () => {
        calls += 1;
      },
    );
    expect(seen).toEqual(['t/2']);
    expect(calls).toBe(1);
  });

  it('passes a reset through and returns what it committed', async () => {
    const managed = new ManagedKafkaSession(
      inner({
        resetGroupOffsets: (group, topic, target) =>
          Promise.resolve([{ partition: 0, before: group, offset: `${topic}:${target.kind}` }]),
      }),
      { onLinkLost: () => undefined },
    );
    expect(await managed.resetGroupOffsets('g', 't', { kind: 'latest' })).toEqual([
      { partition: 0, before: 'g', offset: 't:latest' },
    ]);
  });

  it('reports a lost link when a watch dies of one, and rethrows as DbError', async () => {
    const lost: unknown[] = [];
    const managed = new ManagedKafkaSession(
      inner({
        watchMessages: () =>
          Promise.reject(new DbError('connection-failed', 'the broker went away')),
      }),
      {
        onLinkLost: (error) => {
          lost.push(error);
        },
      },
    );
    await expect(
      managed.watchMessages(
        { topic: 't', partition: 0, signal: new AbortController().signal },
        () => {
          /* nothing */
        },
      ),
    ).rejects.toMatchObject({ code: 'connection-failed' });
    expect(lost).toHaveLength(1);
  });

  it('does not call a refusal to reset a lost link', async () => {
    const lost: unknown[] = [];
    const managed = new ManagedKafkaSession(
      inner({
        resetGroupOffsets: () => Promise.reject(new DbError('constraint', 'the group is running')),
      }),
      {
        onLinkLost: (error) => {
          lost.push(error);
        },
      },
    );
    await expect(managed.resetGroupOffsets('g', 't', { kind: 'earliest' })).rejects.toMatchObject({
      code: 'constraint',
    });
    expect(lost).toEqual([]);
  });
});
