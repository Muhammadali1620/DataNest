import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { NO_BACKGROUND, newTableDesign } from '../../../src/shared/table-design';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import {
  actionDatabase,
  actionRecovery,
  actionScript,
  actionSql,
  SchemaActions,
  type SchemaAction,
} from '../../../src/services/schema-actions';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

describe('actionSql', () => {
  it('builds each action through the dialect', () => {
    const { ddl } = mysqlDialect;
    const table = { database: 'shop', name: 'orders' };
    const cases: [SchemaAction, string][] = [
      [{ kind: 'createDatabase', name: 'x' }, 'CREATE DATABASE `x`'],
      [{ kind: 'dropDatabase', name: 'x' }, 'DROP DATABASE `x`'],
      [{ kind: 'dropTable', table, relation: 'table' }, 'DROP TABLE `shop`.`orders`'],
      [
        { kind: 'renameTable', table, relation: 'table', newName: 'o' },
        'RENAME TABLE `shop`.`orders` TO `shop`.`o`',
      ],
      [{ kind: 'truncateTable', table }, 'TRUNCATE TABLE `shop`.`orders`'],
      [
        { kind: 'dropObject', object: { database: 'shop', kind: 'event', name: 'e' } },
        'DROP EVENT `shop`.`e`',
      ],
    ];
    for (const [action, sql] of cases) {
      expect(actionSql(action, ddl)).toEqual([sql]);
    }
  });

  it('creates a table from a design, with every statement the dialect needs', () => {
    const design = newTableDesign('postgres', 'invoices');
    const statements = actionSql(
      {
        kind: 'createTable',
        table: { schema: 'sales', name: 'invoices' },
        design: { ...design, comment: 'bills' },
      },
      postgresDialect.ddl,
    );
    expect(statements).toHaveLength(2);
    expect(statements[0]).toMatch(/^CREATE TABLE "sales"\."invoices"/);
    expect(statements[1]).toBe(`COMMENT ON TABLE "sales"."invoices" IS 'bills'`);
  });

  it('says unsupported where the database has no such thing', () => {
    for (const action of [
      { kind: 'createDatabase', name: 'x' },
      { kind: 'dropDatabase', name: 'x' },
      { kind: 'createSchema', name: 'x' },
      { kind: 'dropSchema', name: 'x', cascade: false },
    ] as SchemaAction[]) {
      expect(() => actionSql(action, sqliteDialect.ddl)).toThrow(DbError);
    }
    expect(() => actionSql({ kind: 'createSchema', name: 'x' }, mysqlDialect.ddl)).toThrow(
      'This database has no schemas',
    );
  });
});

describe('alterTable actions', () => {
  const before = newTableDesign('postgres', 'orders');
  const action = {
    kind: 'alterTable' as const,
    table: { database: 'shop', schema: 'public', name: 'orders' },
    before,
    after: { ...before, name: 'purchases' },
    background: NO_BACKGROUND,
  };

  it('runs the plan of the dialect inside the table database', () => {
    expect(actionSql(action, postgresDialect.ddl)).toEqual([
      'BEGIN',
      'ALTER TABLE "public"."orders" RENAME TO "purchases"',
      'COMMIT',
    ]);
    expect(actionDatabase(action)).toBe('shop');
  });

  it('knows how to recover from a failed plan, and other actions need nothing', () => {
    expect(actionRecovery(action, postgresDialect.ddl)).toEqual(['ROLLBACK']);
    expect(actionRecovery(action, mysqlDialect.ddl)).toEqual([]);
    expect(actionRecovery({ kind: 'dropDatabase', name: 'x' }, postgresDialect.ddl)).toEqual([]);
  });
});

describe('actionScript', () => {
  it('ends each statement with a semicolon and separates them by a blank line', () => {
    expect(actionScript(['CREATE TABLE a (id int)', "COMMENT ON TABLE a IS 'x'"])).toBe(
      "CREATE TABLE a (id int);\n\nCOMMENT ON TABLE a IS 'x';",
    );
    expect(actionScript([])).toBe('');
  });
});

describe('actionDatabase', () => {
  it('runs database changes from the connection default, the rest inside their database', () => {
    expect(actionDatabase({ kind: 'dropDatabase', name: 'shop' })).toBeUndefined();
    expect(actionDatabase({ kind: 'createDatabase', name: 'shop' })).toBeUndefined();
    expect(actionDatabase({ kind: 'createSchema', database: 'shop', name: 's' })).toBe('shop');
    expect(
      actionDatabase({
        kind: 'dropTable',
        table: { database: 'app', name: 't' },
        relation: 'view',
      }),
    ).toBe('app');
    expect(
      actionDatabase({ kind: 'dropObject', object: { database: 'x', kind: 'event', name: 'e' } }),
    ).toBe('x');
    expect(actionDatabase({ kind: 'truncateTable', table: { name: 't' } })).toBeUndefined();
  });
});

describe('SchemaActions', () => {
  let store: ConnectionStore;
  let drivers: FakeDriverProvider;
  let manager: ConnectionManager;
  let invalidated: (string | undefined)[];
  let actions: SchemaActions;

  beforeEach(() => {
    const logger = new RecordingLogger();
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    drivers = new FakeDriverProvider();
    manager = new ConnectionManager({ store, drivers, logger });
    invalidated = [];
    actions = new SchemaActions({
      manager,
      cache: { invalidate: (id) => invalidated.push(id) },
      logger,
    });
  });

  it('shows the dialect SQL', async () => {
    const config = await store.add({ name: 'L', driver: 'mysql', host: 'h' });
    expect(await actions.sqlOf(config.id, { kind: 'truncateTable', table: { name: 't' } })).toEqual(
      ['TRUNCATE "t"'],
    );
  });

  it('rolls back a failed ALTER and lets the first error through', async () => {
    const config = await store.add({ name: 'L', driver: 'mysql', host: 'h' });
    drivers.driver('mysql').failExecuteWhen = (sql) => sql.startsWith('ALTER');
    const design = newTableDesign('mysql', 'orders');
    await expect(
      actions.run(
        config.id,
        {
          kind: 'alterTable',
          table: { name: 'orders' },
          before: design,
          after: { ...design, name: 'x' },
          background: NO_BACKGROUND,
        },
        ['BEGIN', 'ALTER x', 'COMMIT'],
      ),
    ).rejects.toThrow('Not allowed: ALTER x');
    // The fake dialect recovers with ROLLBACK; COMMIT never runs.
    expect(drivers.driver('mysql').lastSession?.executed).toEqual(['BEGIN', 'ALTER x', 'ROLLBACK']);
    expect(invalidated).toEqual([config.id]);
  });

  it('keeps going when a recovery statement fails too', async () => {
    const config = await store.add({ name: 'L', driver: 'mysql', host: 'h' });
    drivers.driver('mysql').failExecuteWhen = (sql) => sql !== 'BEGIN';
    const design = newTableDesign('mysql', 'orders');
    await expect(
      actions.run(
        config.id,
        {
          kind: 'alterTable',
          table: { name: 'orders' },
          before: design,
          after: { ...design, name: 'x' },
          background: NO_BACKGROUND,
        },
        ['BEGIN', 'ALTER x'],
      ),
    ).rejects.toThrow('Not allowed: ALTER x');
    expect(drivers.driver('mysql').lastSession?.executed).toEqual(['BEGIN', 'ALTER x', 'ROLLBACK']);
  });

  it('stops at the first failing statement', async () => {
    const config = await store.add({ name: 'L', driver: 'mysql', host: 'h' });
    drivers.driver('mysql').failExecuteWhen = (sql) => sql === 'BAD';
    await expect(
      actions.run(config.id, { kind: 'truncateTable', table: { name: 't' } }, [
        'GOOD',
        'BAD',
        'NEVER',
      ]),
    ).rejects.toThrow('Not allowed: BAD');
    expect(drivers.driver('mysql').lastSession?.executed).toEqual(['GOOD', 'BAD']);
  });

  it('runs exactly the confirmed SQL on the browsing session and drops the cache', async () => {
    const config = await store.add({ name: 'L', driver: 'mysql', host: 'h' });
    await actions.run(config.id, { kind: 'truncateTable', table: { name: 't' } }, [
      'TRUNCATE x',
      'SELECT 2',
    ]);
    const session = drivers.driver('mysql').lastSession;
    expect(session?.executed).toEqual(['TRUNCATE x', 'SELECT 2']);
    expect(manager.sessionOf(ConnectionManager.treeOwner(config.id))).toBeDefined();
    expect(invalidated).toEqual([config.id]);
  });

  it('drops the cache even when the statement fails, and lets the error through', async () => {
    const config = await store.add({ name: 'L', driver: 'mysql', host: 'h' });
    drivers.driver('mysql').failExecuteWhen = () => true;
    await expect(
      actions.run(config.id, { kind: 'dropDatabase', name: 'x' }, ['DROP DATABASE x']),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(invalidated).toEqual([config.id]);
  });

  it('works inside the database of a database-scoped server', async () => {
    const config = await store.add({ name: 'PG', driver: 'postgres', host: 'h' });
    const driver = drivers.driver('postgres');
    driver.capabilities = { ...driver.capabilities, schemas: true, databaseScopedSessions: true };
    await actions.run(config.id, { kind: 'createSchema', database: 'shop', name: 's' }, [
      'CREATE SCHEMA s',
    ]);
    expect(manager.sessionOf(ConnectionManager.treeOwner(config.id, 'shop'))).toBeDefined();
    expect(driver.opened.at(-1)?.database).toBe('shop');
  });

  it('closes the tree session inside a database before dropping it', async () => {
    const config = await store.add({ name: 'PG', driver: 'postgres', host: 'h' });
    const driver = drivers.driver('postgres');
    driver.capabilities = { ...driver.capabilities, schemas: true, databaseScopedSessions: true };
    await manager.acquire(ConnectionManager.treeOwner(config.id, 'old'), {
      connectionId: config.id,
      database: 'old',
    });
    const inside = driver.lastSession;
    await actions.run(config.id, { kind: 'dropDatabase', name: 'old' }, ['DROP DATABASE old']);
    expect(inside?.isClosed).toBe(true);
    // The drop itself ran from the connection's own database.
    expect(driver.lastSession?.executed).toEqual(['DROP DATABASE old']);
    expect(driver.lastSession?.config.database).toBeUndefined();
  });
});
