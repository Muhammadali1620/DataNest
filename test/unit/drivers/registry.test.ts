import { describe, expect, it, vi } from 'vitest';
import type { DriverId } from '../../../src/core/model/connection';
import type { Driver, DriverModule } from '../../../src/drivers/driver';
import { DriverRegistry } from '../../../src/drivers/registry';
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
    },
    capabilities: { databases: true, schemas: false, cancel: true },
    openSession: () => Promise.reject(new Error('not implemented')),
  };
}

function registryWith(load: (id: DriverId) => Promise<DriverModule>) {
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
    await expect(registry.get('oracle' as DriverId)).rejects.toMatchObject({
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
});
