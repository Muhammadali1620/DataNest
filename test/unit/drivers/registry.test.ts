import { describe, expect, it, vi } from 'vitest';
import type { DriverId, SqlDriverId } from '../../../src/shared/connection';
import type { Driver, DriverModule } from '../../../src/drivers/driver';
import type { RedisDriver, RedisDriverModule } from '../../../src/drivers/redis-driver';
import { DriverRegistry } from '../../../src/drivers/registry';
import { fakeDialect } from '../../helpers/fake-driver';
import { RecordingLogger } from '../../helpers/fakes';

function fakeDriver(id: DriverId): Driver {
  return {
    id,
    dialect: {
      keywords: [],
      quoteIdentifier: (name) => name,
      quoteTable: (table) => table.name,
      literal: () => 'NULL',
      paginate: (sql) => sql,
      likeText: () => '',
      defaultKeyword: true,
      insertDefaultRow: () => '',
      transaction: fakeDialect.transaction,
      ddl: {
        designer: {
          columnComments: false,
          tableComment: false,
          types: [],
          reorder: false,
          autoIncrement: true,
          foreignKeys: true,
          uniqueIndexes: true,
        },
        createTable: () => [],
        alterTable: () => ({ statements: [], notes: [], recovery: [] }),
        dropRelation: () => '',
        renameRelation: () => '',
        truncateTable: () => '',
        dropObject: () => '',
        replaceObject: () => ({ check: [], statements: [], recovery: [] }),
      },
      dump: fakeDialect.dump,
    },
    capabilities: {
      databases: true,
      schemas: false,
      databaseScopedSessions: false,
      cancel: true,
      transactions: true,
      objectKinds: [],
    },
    openSession: () => Promise.reject(new Error('not implemented')),
  };
}

function registryWith(load: (id: DriverId) => Promise<DriverModule | RedisDriverModule>) {
  return new DriverRegistry({ loader: load, logger: new RecordingLogger() });
}

describe('DriverRegistry', () => {
  it('loads a driver through the loader and returns it', async () => {
    const registry = registryWith((id) => Promise.resolve({ driver: fakeDriver(id) }));
    const driver = await registry.get('mysql');
    expect(driver.id).toBe('mysql');
  });

  it('loads each driver only once and shares concurrent loads', async () => {
    const loader = vi.fn((id: DriverId) => Promise.resolve({ driver: fakeDriver(id) }));
    const registry = registryWith(loader);
    const [a, b] = await Promise.all([registry.get('postgres'), registry.get('postgres')]);
    const c = await registry.get('postgres');
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('keeps separate instances per driver id', async () => {
    const registry = registryWith((id) => Promise.resolve({ driver: fakeDriver(id) }));
    const mysql = await registry.get('mysql');
    const sqlite = await registry.get('sqlite');
    expect(mysql.id).toBe('mysql');
    expect(sqlite.id).toBe('sqlite');
  });

  it('rejects unknown driver ids without calling the loader', async () => {
    const loader = vi.fn();
    const registry = registryWith(loader as never);
    await expect(registry.get('db2' as SqlDriverId)).rejects.toMatchObject({
      name: 'DbError',
      code: 'unsupported',
    });
    expect(loader).not.toHaveBeenCalled();
  });

  it('wraps loader failures in DbError and allows a retry', async () => {
    let calls = 0;
    const registry = registryWith((id) => {
      calls++;
      return calls === 1
        ? Promise.reject(new Error('module not found'))
        : Promise.resolve({ driver: fakeDriver(id) });
    });
    await expect(registry.get('mysql')).rejects.toMatchObject({
      name: 'DbError',
      code: 'internal',
    });
    const driver = await registry.get('mysql');
    expect(driver.id).toBe('mysql');
    expect(calls).toBe(2);
  });

  it('rejects a module with a wrong shape', async () => {
    const registry = registryWith(() => Promise.resolve({} as DriverModule));
    await expect(registry.get('mysql')).rejects.toThrow('unexpected module shape');
  });

  it('rejects a module whose driver reports a different id', async () => {
    const registry = registryWith(() => Promise.resolve({ driver: fakeDriver('postgres') }));
    await expect(registry.get('mysql')).rejects.toThrow('unexpected module shape');
  });

  describe('Redis (V7.1)', () => {
    const redis: RedisDriver = { id: 'redis', openSession: () => Promise.reject(new Error('no')) };

    it('loads the Redis bundle once', async () => {
      const loader = vi.fn((id: DriverId) =>
        Promise.resolve(id === 'redis' ? { driver: redis } : { driver: fakeDriver(id) }),
      );
      const registry = registryWith(loader);
      const [a, b] = await Promise.all([registry.getRedis(), registry.getRedis()]);
      expect(a).toBe(redis);
      expect(b).toBe(redis);
      expect(loader).toHaveBeenCalledTimes(1);
      expect(loader).toHaveBeenCalledWith('redis');
    });

    it('never hands Redis out as a SQL driver', async () => {
      const loader = vi.fn(() => Promise.resolve({ driver: redis }));
      const registry = registryWith(loader);
      await expect(registry.get('redis' as SqlDriverId)).rejects.toMatchObject({
        code: 'unsupported',
      });
      expect(loader).not.toHaveBeenCalled();
    });

    it('rejects a Redis bundle with a wrong shape, or a SQL driver in its place', async () => {
      await expect(
        registryWith(() => Promise.resolve({ driver: { id: 'redis' } } as never)).getRedis(),
      ).rejects.toThrow('unexpected module shape');
      await expect(
        registryWith(() =>
          Promise.resolve({ driver: { ...fakeDriver('mysql'), id: 'redis' } } as never),
        ).getRedis(),
      ).rejects.toThrow('unexpected module shape');
    });

    it('rejects a SQL bundle that carries no dialect', async () => {
      await expect(
        registryWith(() =>
          Promise.resolve({ driver: { id: 'mysql', openSession: () => undefined } } as never),
        ).get('mysql'),
      ).rejects.toThrow('unexpected module shape');
    });
  });
});
