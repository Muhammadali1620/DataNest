import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { Session } from '../../../src/drivers/driver';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { FakeDriver, FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { pick, seeded } from '../../helpers/fuzz';

/** A driver that opens slowly and sometimes not at all, so calls overlap and fail. */
class SlowDriver extends FakeDriver {
  constructor(private readonly random: () => number) {
    super('mysql');
  }

  override async openSession(config: ResolvedConnectionConfig): Promise<Session> {
    await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(this.random() * 4)));
    if (this.random() < 0.15) {
      throw new DbError('connection-failed', 'refused');
    }
    return await super.openSession(config);
  }
}

describe('ConnectionManager under overlapping calls (V14.3)', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`closes every session it opened, once, whatever the order (seed ${seed})`, async () => {
      const random = seeded(seed);
      const driver = new SlowDriver(random);
      const drivers = new FakeDriverProvider(new Map([['mysql', driver]]));
      const logger = new RecordingLogger();
      const store = new ConnectionStore({
        state: new FakeMemento(),
        secrets: new FakeSecretStorage(),
        logger,
      });
      const manager = new ConnectionManager({ store, drivers, logger });
      const ids: string[] = [];
      for (const name of ['One', 'Two']) {
        const config = await store.add(
          { name, driver: 'mysql', host: '127.0.0.1', port: 7306, user: 'u', database: 'app' },
          'secret',
        );
        ids.push(config.id);
      }
      const owners = ['editor:a', 'editor:b', 'editor:c', 'tree:x'];

      const calls: Promise<unknown>[] = [];
      for (let burst = 0; burst < 25; burst += 1) {
        const size = 1 + Math.floor(random() * 6);
        for (let index = 0; index < size; index += 1) {
          const connectionId = pick(random, ids);
          const owner = pick(random, owners);
          const action = pick(random, [
            'acquire',
            'acquire',
            'release',
            'disconnect',
            'connect',
          ] as const);
          switch (action) {
            case 'acquire':
              calls.push(manager.acquire(owner, { connectionId }).catch(() => undefined));
              break;
            case 'release':
              calls.push(manager.release(owner).catch(() => undefined));
              break;
            case 'disconnect':
              calls.push(manager.disconnect(connectionId).catch(() => undefined));
              break;
            case 'connect':
              calls.push(manager.connect(connectionId).catch(() => undefined));
              break;
          }
        }
        await new Promise<void>((resolve) => setTimeout(resolve, Math.floor(random() * 3)));
      }
      await Promise.all(calls);
      for (const id of ids) {
        await manager.disconnect(id);
      }
      for (const owner of owners) {
        await manager.release(owner);
      }

      const label = `seed ${seed}: ${driver.sessions.length} opened`;
      // The run must have opened something, or the checks below prove nothing.
      expect(driver.sessions.length, label).toBeGreaterThan(3);
      for (const [index, session] of driver.sessions.entries()) {
        expect(session.closeCount, `${label}, session ${index}`).toBe(1);
      }
      for (const id of ids) {
        expect(manager.getState(id).status, `${label}, ${id}`).not.toBe('connected');
      }
      expect(manager.connectedIds(), label).toEqual([]);
    }, 30_000);
  }
});
