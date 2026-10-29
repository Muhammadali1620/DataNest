// Session options against real servers (V4.9): the time zone and init SQL that the
// connection manager runs on every new session, MySQL's character set, and the
// connect timeout against a server that accepts the socket and then says nothing.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { driver as mssqlDriver } from '../../../src/drivers/mssql';
import { driver as clickhouseDriver } from '../../../src/drivers/clickhouse';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import type { ConnectionInput, DriverId } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;
let silent: Server;
let silentPort: number;
const sockets: Socket[] = [];

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-options-'));
  // Accepts connections and never answers: what a firewall that drops packets looks like.
  silent = createServer((socket) => {
    sockets.push(socket);
  });
  await new Promise<void>((resolve) => {
    silent.listen(0, '127.0.0.1', resolve);
  });
  const address = silent.address();
  silentPort = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(async () => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
  for (const socket of sockets) {
    socket.destroy();
  }
  await new Promise<void>((resolve) => {
    silent.close(() => {
      resolve();
    });
  });
});

/** A manager over the real drivers, with one saved connection. */
async function managerFor(input: ConnectionInput, password?: string) {
  const logger = new RecordingLogger();
  const store = new ConnectionStore({
    state: new FakeMemento(),
    secrets: new FakeSecretStorage(),
    logger,
  });
  const sqlite = createSqliteDriver({ workerPath: worker.workerPath });
  const drivers: Record<DriverId, Driver> = {
    mysql: mysqlDriver,
    postgres: postgresDriver,
    sqlite,
    mssql: mssqlDriver,
    clickhouse: clickhouseDriver,
  };
  const manager = new ConnectionManager({
    store,
    drivers: { get: (id) => Promise.resolve(drivers[id]) },
    logger,
  });
  const config = await store.add(input, password);
  return { manager, config };
}

async function scalar(
  manager: ConnectionManager,
  connectionId: string,
  sql: string,
): Promise<unknown> {
  const session = await manager.acquire('editor:probe', { connectionId });
  for await (const event of session.execute(sql)) {
    if (event.kind === 'rows') {
      return event.rows[0]?.[0];
    }
  }
  return undefined;
}

function server(id: TestDatabaseId, options: ConnectionInput['options']): ConnectionInput {
  const db = testDatabase(id);
  return {
    name: id,
    driver: id === 'postgres' ? 'postgres' : 'mysql',
    host: db.host,
    port: db.port,
    user: db.user,
    database: db.database,
    options,
  };
}

describe.each(['mysql', 'mariadb'] as const)('session options on %s', (id) => {
  it('sets the time zone and runs the init SQL on every session', async () => {
    const { manager, config } = await managerFor(
      server(id, { timeZone: '+03:00', initSql: 'SET @datanest_probe = 42; SET @other = 1' }),
      'datanest',
    );
    try {
      expect(await scalar(manager, config.id, 'SELECT @@session.time_zone')).toBe('+03:00');
      expect(await scalar(manager, config.id, 'SELECT @datanest_probe')).toBe(42);
    } finally {
      manager.dispose();
    }
  });

  it('talks the character set the connection names, text intact both ways', async () => {
    const { manager, config } = await managerFor(server(id, { charset: 'latin1' }), 'datanest');
    try {
      expect(await scalar(manager, config.id, 'SELECT @@character_set_client')).toBe('latin1');
      expect(await scalar(manager, config.id, "SELECT 'café'")).toBe('café');
    } finally {
      manager.dispose();
    }
  });

  it('refuses an unknown character set before connecting', async () => {
    const { manager, config } = await managerFor(server(id, { charset: 'klingon' }), 'datanest');
    try {
      await expect(manager.connect(config.id)).rejects.toThrow('Unknown character set');
    } finally {
      manager.dispose();
    }
  });

  it('fails the connect when the server refuses the time zone, naming it', async () => {
    const { manager, config } = await managerFor(server(id, { timeZone: 'Mars/Base' }), 'datanest');
    try {
      await expect(manager.connect(config.id)).rejects.toThrow('refused the time zone "Mars/Base"');
    } finally {
      manager.dispose();
    }
  });
});

describe('session options on postgres', () => {
  it('sets the time zone and the search path from the init SQL', async () => {
    const { manager, config } = await managerFor(
      server('postgres', {
        timeZone: 'Europe/Berlin',
        initSql: 'SET search_path = inventory, public',
      }),
      'datanest',
    );
    try {
      expect(await scalar(manager, config.id, 'SHOW TimeZone')).toBe('Europe/Berlin');
      expect(await scalar(manager, config.id, 'SHOW search_path')).toBe('inventory, public');
    } finally {
      manager.dispose();
    }
  });

  it('names the init statement the server rejected', async () => {
    const { manager, config } = await managerFor(
      server('postgres', { initSql: 'SET no_such_setting = 1' }),
      'datanest',
    );
    try {
      await expect(manager.connect(config.id)).rejects.toThrow(
        'Init SQL failed at "SET no_such_setting = 1"',
      );
    } finally {
      manager.dispose();
    }
  });
});

describe('session options on sqlite', () => {
  it('runs the init SQL, e.g. turning foreign keys on', async () => {
    const { manager, config } = await managerFor({
      name: 'lite',
      driver: 'sqlite',
      file: join(dir, 'options.db'),
      options: { initSql: 'PRAGMA foreign_keys = ON' },
    });
    try {
      expect(await scalar(manager, config.id, 'PRAGMA foreign_keys')).toBe(1);
    } finally {
      manager.dispose();
    }
  });
});

describe.each(['mysql', 'postgres'] as const)('connect timeout on %s', (driver) => {
  it('gives up on a silent server after the seconds the connection says', async () => {
    const { manager, config } = await managerFor({
      name: 'silent',
      driver,
      host: '127.0.0.1',
      port: silentPort,
      user: 'nobody',
      options: { connectTimeout: 1 },
    });
    try {
      const started = Date.now();
      await expect(manager.connect(config.id)).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      manager.dispose();
    }
  });
});
