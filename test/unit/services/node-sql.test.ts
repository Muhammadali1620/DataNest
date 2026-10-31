import { beforeEach, describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { nodeSqlDatabase, readNodeSql } from '../../../src/services/node-sql';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

describe('readNodeSql (V11.12)', () => {
  let drivers: FakeDriverProvider;
  let manager: ConnectionManager;
  let pg: string;
  let my: string;

  beforeEach(async () => {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    drivers = new FakeDriverProvider();
    drivers.driver('postgres').dialect = postgresDialect;
    drivers.driver('mysql').dialect = mysqlDialect;
    manager = new ConnectionManager({ store, drivers, logger });
    pg = (await store.add({ name: 'Pg', driver: 'postgres', host: 'h' })).id;
    my = (await store.add({ name: 'My', driver: 'mysql', host: 'h' })).id;
  });

  const TABLE = { database: 'app', schema: 'public', name: 'orders' };

  it('writes the column from what describeTable knows: comment, numbering, default', async () => {
    drivers.driver('mysql').sessionMetadata.structure = {
      columns: [
        {
          name: 'id',
          dataType: 'bigint unsigned',
          nullable: false,
          autoIncrement: true,
          generated: false,
          comment: 'key',
        },
      ],
      primaryKey: ['id'],
      indexes: [],
      foreignKeys: [],
    };
    const sql = await readNodeSql(manager, my, {
      kind: 'column',
      table: { database: 'app', name: 'orders' },
      column: { name: 'id', dataType: 'bigint unsigned', nullable: false, primaryKey: true },
    });
    expect(sql).toContain(
      "MODIFY COLUMN `id` bigint unsigned NOT NULL AUTO_INCREMENT COMMENT 'key';",
    );
  });

  it('falls back to the listing when the structure cannot be read', async () => {
    const sql = await readNodeSql(manager, pg, {
      kind: 'column',
      table: TABLE,
      column: {
        name: 'note',
        dataType: 'text',
        nullable: true,
        primaryKey: false,
        defaultValue: "'x'",
      },
    });
    expect(sql).toContain('ALTER COLUMN "note" TYPE text;');
    expect(sql).toContain(`SET DEFAULT 'x';`);
    expect(sql).toContain('DROP NOT NULL;');
  });

  it('writes an index and a foreign key from the node alone', async () => {
    const index = await readNodeSql(manager, pg, {
      kind: 'index',
      table: TABLE,
      index: { name: 'ix', columns: ['a'], unique: false, primary: false },
    });
    expect(index).toContain('CREATE INDEX "ix" ON "public"."orders" ("a");');
    const key = await readNodeSql(manager, my, {
      kind: 'foreignKey',
      table: { database: 'app', name: 'orders' },
      key: { name: 'fk', columns: ['a'], target: { name: 'u' }, targetColumns: ['id'] },
    });
    expect(key).toContain('DROP FOREIGN KEY `fk`;');
  });

  it('opens the definition of a trigger as CREATE OR REPLACE on PostgreSQL only', async () => {
    const create = 'CREATE TRIGGER audit BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION f()';
    drivers.driver('postgres').sessionMetadata.definitions.set('trigger:audit', [create]);
    drivers.driver('mysql').sessionMetadata.definitions.set('trigger:audit', [create]);
    const object = { kind: 'trigger', name: 'audit', table: 'orders' } as const;
    const onPg = await readNodeSql(manager, pg, {
      kind: 'object',
      object: { ...object, schema: 'public' },
    });
    expect(onPg).toBe(`${create.replace('CREATE', 'CREATE OR REPLACE')};\n`);
    const onMysql = await readNodeSql(manager, my, { kind: 'object', object });
    expect(onMysql).toContain('CREATE TRIGGER audit');
    expect(onMysql).not.toContain('OR REPLACE');
  });

  it('opens the definition of a routine as it is', async () => {
    drivers
      .driver('postgres')
      .sessionMetadata.definitions.set('function:f', ['CREATE FUNCTION f() ...']);
    expect(
      await readNodeSql(manager, pg, { kind: 'object', object: { kind: 'function', name: 'f' } }),
    ).toBe('CREATE FUNCTION f() ...;\n');
  });

  it('passes on the error of a definition that is gone', async () => {
    await expect(
      readNodeSql(manager, pg, { kind: 'object', object: { kind: 'trigger', name: 'gone' } }),
    ).rejects.toThrow(/does not exist/u);
  });
});

describe('nodeSqlDatabase', () => {
  it('is the database of the table or the object', () => {
    expect(
      nodeSqlDatabase({
        kind: 'index',
        table: { database: 'app', name: 't' },
        index: { name: 'i', columns: [], unique: false, primary: false },
      }),
    ).toBe('app');
    expect(
      nodeSqlDatabase({ kind: 'object', object: { kind: 'event', name: 'e' } }),
    ).toBeUndefined();
    expect(
      nodeSqlDatabase({ kind: 'object', object: { kind: 'event', name: 'e', database: 'd' } }),
    ).toBe('d');
  });
});
