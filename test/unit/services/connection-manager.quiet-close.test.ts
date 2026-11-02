// A session that will not close must never fail what the user asked for: the test of a
// connection, a lost link and the end of the extension all close sessions quietly (D26).
// Every family goes through the same code, so each is tried with a session whose close fails.

import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { ConnectionManager as Manager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import type { DriverId } from '../../../src/shared/connection';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeRabbitDriver } from '../../helpers/fake-rabbitmq';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

/** A driver of any non-SQL family whose session opens but cannot be closed. */
function stubborn(id: DriverId): { id: DriverId; openSession: () => Promise<unknown> } {
  return {
    id,
    openSession: () =>
      Promise.resolve({
        server: {},
        close: () => Promise.reject(new Error('cannot close')),
      }),
  };
}

function setup(replace: Partial<Record<DriverId, unknown>> = {}) {
  const logger = new RecordingLogger();
  const store = new ConnectionStore({
    state: new FakeMemento(),
    secrets: new FakeSecretStorage(),
    logger,
  });
  const rabbit = new FakeRabbitDriver();
  rabbit.session.close = () => Promise.reject(new Error('cannot close'));
  const drivers = Object.assign(new FakeDriverProvider(), {
    getRedis: () => Promise.resolve(stubborn('redis')),
    getMongo: () => Promise.resolve(replace.mongodb ?? stubborn('mongodb')),
    getElastic: () => Promise.resolve(replace.elasticsearch ?? stubborn('elasticsearch')),
    getEtcd: () => Promise.resolve(replace.etcd ?? stubborn('etcd')),
    getKafka: () => Promise.resolve(replace.kafka ?? stubborn('kafka')),
    getRabbit: () => Promise.resolve(replace.rabbitmq ?? rabbit),
  });
  const manager = new Manager({ store, drivers: drivers as never, logger });
  return { store, manager, rabbit };
}

const FAMILIES = ['mongodb', 'elasticsearch', 'etcd', 'kafka', 'rabbitmq'] as const;

/** A driver of any non-SQL family that cannot open a session at all. */
function broken(id: DriverId): { id: DriverId; openSession: () => Promise<unknown> } {
  return { id, openSession: () => Promise.reject(new DbError('connection-failed', 'no route')) };
}

describe('ConnectionManager reports a failed test of a connection', () => {
  it.each(['mongodb', 'elasticsearch', 'etcd', 'kafka', 'rabbitmq'] as const)(
    'for %s, with the driver’s own error',
    async (driver) => {
      const { manager } = setup({ [driver]: broken(driver) });
      await expect(manager.test({ name: 't', driver, host: 'h' })).rejects.toMatchObject({
        code: 'connection-failed',
        message: 'no route',
      });
    },
  );
});

describe('ConnectionManager closes sessions quietly', () => {
  it.each(FAMILIES)(
    'tests a %s connection even when its session will not close',
    async (driver) => {
      const { manager } = setup();
      await expect(manager.test({ name: 't', driver, host: 'h' })).resolves.toBeUndefined();
    },
  );

  it('forgets a lost RabbitMQ link although its session will not close', async () => {
    const { store, manager, rabbit } = setup();
    const broker = await store.add({ name: 'B', driver: 'rabbitmq', host: 'h' });
    await manager.acquireRabbit('a', { connectionId: broker.id });
    rabbit.session.failures.set('listVhosts', new DbError('connection-failed', 'gone'));
    await expect(manager.rabbitSessionOf('a')?.listVhosts()).rejects.toMatchObject({
      code: 'connection-failed',
    });
    // The dead session was dropped, and closing it failed without anyone noticing.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(manager.rabbitSessionOf('a')).toBeUndefined();
    expect(manager.getState(broker.id).status).toBe('error');
  });

  it('ends without waiting for sessions that will not close', async () => {
    const { store, manager } = setup();
    const broker = await store.add({ name: 'B', driver: 'rabbitmq', host: 'h' });
    await manager.acquireRabbit('a', { connectionId: broker.id });
    expect(() => {
      manager.dispose();
    }).not.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
