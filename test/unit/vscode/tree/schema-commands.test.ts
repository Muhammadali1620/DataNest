import { NO_POLICY, type WritePolicy } from '../../../../src/services/write-policy';
import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { Driver } from '../../../../src/drivers/driver';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import type { SchemaAction } from '../../../../src/services/schema-actions';
import type { DriverId } from '../../../../src/shared/connection';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import {
  schemaCommandHandlers,
  type SchemaTexts,
  type SchemaUi,
} from '../../../../src/vscode/tree/schema-commands';

const TEXTS: SchemaTexts = {
  noDatabases: 'no databases',
  noSchemas: 'no schemas',
  newDatabaseName: 'database name',
  newSchemaName: 'schema name',
  renameTo: (name) => `rename ${name}`,
  typeToConfirm: (name) => `type ${name}`,
  typeExactly: 'type exactly',
  emptyName: 'empty',
  nulInName: 'nul',
  tooLong: (limit) => `max ${limit}`,
  sameName: 'same',
  createDatabase: (name) => `create db ${name}?`,
  dropDatabase: (name) => `drop db ${name}?`,
  createSchema: (name) => `create schema ${name}?`,
  dropSchema: (name) => `drop schema ${name}?`,
  schemaOnlyIfEmpty: 'only if empty',
  schemaCascade: 'cascade',
  createTable: (name) => `create table ${name}?`,
  alterTable: (name) => `alter table ${name}?`,
  apply: 'Apply',
  dropRelation: (name) => `drop ${name}?`,
  rename: (from, to) => `rename ${from} to ${to}?`,
  truncate: (name) => `truncate ${name}?`,
  dropObject: (name) => `drop object ${name}?`,
  create: 'Create',
  drop: 'Drop',
  renameLabel: 'Rename',
  truncateLabel: 'Empty',
  done: (summary) => `done ${summary}`,
  readOnlyRefused: (connection) => `read-only ${connection}`,
  onProduction: (connection, title) => `PROD ${connection}: ${title}`,
};

const DIALECTS = { mysql: mysqlDialect, postgres: postgresDialect, sqlite: sqliteDialect };

interface Script {
  /** Answers to askName in order; undefined cancels. */
  names?: (string | undefined)[];
  confirm?: 'run' | 'edit' | undefined;
  pick?: unknown;
  driver?: DriverId;
  /** Makes sqlOf fail as unsupported. */
  unsupported?: string;
  policy?: WritePolicy;
}

function setup(script: Script = {}) {
  const driverId = script.driver ?? 'mysql';
  const names = [...(script.names ?? [])];
  const asked: { title: string; value?: string; validate: (name: string) => string | undefined }[] =
    [];
  const confirmed: { title: string; sql: string; runLabel: string }[] = [];
  const infos: string[] = [];
  const ui: SchemaUi = {
    askName: (options) => {
      asked.push(options);
      return Promise.resolve(names.shift());
    },
    confirm: (options) => {
      confirmed.push(options);
      return Promise.resolve(script.confirm);
    },
    pick: <T>(_title: string, _options: readonly { label: string; value: T }[]) =>
      Promise.resolve(script.pick as T | undefined),
    info: (message) => {
      infos.push(message);
    },
  };
  const ran: { connectionId: string; action: SchemaAction; sql: string }[] = [];
  const actions = {
    sqlOf: vi.fn((_id: string, action: SchemaAction) =>
      script.unsupported === undefined
        ? Promise.resolve([`SQL ${action.kind}\nsecond line`])
        : Promise.reject(new DbError('unsupported', script.unsupported)),
    ),
    run: vi.fn((connectionId: string, action: SchemaAction, statements: readonly string[]) => {
      ran.push({ connectionId, action, sql: statements.join('|') });
      return Promise.resolve();
    }),
  };
  const driver = {
    id: driverId,
    dialect: DIALECTS[driverId],
    capabilities: {
      databases: driverId !== 'sqlite',
      schemas: driverId === 'postgres',
      databaseScopedSessions: driverId === 'postgres',
      cancel: true,
      objectKinds: [],
    },
  } as unknown as Driver;
  const refresh = vi.fn();
  const opened: { binding: unknown; sql: string }[] = [];
  const designers: { connectionId: string; scope: unknown; table?: string }[] = [];
  const handlers = schemaCommandHandlers({
    actions,
    manager: { driverOf: () => Promise.resolve(driver) },
    ui,
    texts: TEXTS,
    ...(script.policy === undefined ? {} : { policy: () => script.policy ?? NO_POLICY }),
    tree: { refresh },
    openEditor: (binding, sql) => {
      opened.push({ binding, sql });
      return Promise.resolve();
    },
    openDesigner: (connectionId, scope, table) => {
      designers.push({ connectionId, scope, ...(table === undefined ? {} : { table }) });
      return Promise.resolve();
    },
  });
  return { handlers, asked, confirmed, infos, ran, refresh, opened, actions, designers };
}

const database: TreeNode = { kind: 'database', connectionId: 'c1', database: 'shop' };
const schema: TreeNode = { kind: 'schema', connectionId: 'c1', database: 'shop', schema: 'sales' };
const table: TreeNode = {
  kind: 'table',
  connectionId: 'c1',
  scope: { database: 'shop' },
  name: 'orders',
  tableKind: 'table',
};

describe('production and read-only connections', () => {
  it('refuses any structure change on a read-only connection before building SQL', async () => {
    const { handlers, confirmed, infos, ran, actions } = setup({
      names: ['new_db'],
      confirm: 'run',
      policy: { name: 'Prod', production: true, readOnly: true },
    });
    await handlers.createDatabase(database);
    expect(infos).toEqual(['read-only Prod']);
    expect(confirmed).toEqual([]);
    expect(ran).toEqual([]);
    expect(actions.sqlOf).not.toHaveBeenCalled();
  });

  it('marks the SQL dialog of a production connection and still runs on yes', async () => {
    const { handlers, confirmed, ran } = setup({
      names: ['new_db'],
      confirm: 'run',
      policy: { name: 'Prod', production: true, readOnly: false },
    });
    await handlers.createDatabase(database);
    expect(confirmed[0]?.title).toMatch(/^PROD Prod: /);
    expect(ran).toHaveLength(1);
  });

  it('leaves the dialog alone for other connections', async () => {
    const { handlers, confirmed } = setup({
      names: ['new_db'],
      confirm: 'run',
      policy: { name: 'Dev', production: false, readOnly: false },
    });
    await handlers.createDatabase(database);
    expect(confirmed[0]?.title).not.toContain('PROD');
  });
});

describe('the shared flow', () => {
  it('shows the SQL, runs it, refreshes the tree and reports the first line', async () => {
    const harness = setup({ confirm: 'run' });
    await harness.handlers.dropTable(table);
    expect(harness.confirmed).toEqual([
      { title: 'drop orders?', sql: 'SQL dropTable\nsecond line;', runLabel: 'Drop' },
    ]);
    expect(harness.ran).toEqual([
      {
        connectionId: 'c1',
        action: {
          kind: 'dropTable',
          table: { database: 'shop', name: 'orders' },
          relation: 'table',
        },
        sql: 'SQL dropTable\nsecond line',
      },
    ]);
    expect(harness.refresh).toHaveBeenCalledOnce();
    expect(harness.infos).toEqual(['done SQL dropTable']);
  });

  it('opens the SQL in an editor on the same connection and database instead of running', async () => {
    const harness = setup({ confirm: 'edit' });
    await harness.handlers.truncateTable(table);
    expect(harness.ran).toEqual([]);
    expect(harness.opened).toEqual([
      {
        binding: { connectionId: 'c1', database: 'shop' },
        sql: 'SQL truncateTable\nsecond line;',
      },
    ]);
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it('opens a database-level action on the connection default', async () => {
    const harness = setup({ confirm: 'edit', names: ['shop'] });
    await harness.handlers.dropDatabase(database);
    expect(harness.opened[0]?.binding).toEqual({ connectionId: 'c1' });
  });

  it('does nothing when the dialog is dismissed', async () => {
    const harness = setup({ confirm: undefined });
    await harness.handlers.dropTable(table);
    expect(harness.ran).toEqual([]);
    expect(harness.opened).toEqual([]);
    expect(harness.infos).toEqual([]);
  });

  it('explains an action the database cannot do instead of failing', async () => {
    const harness = setup({ unsupported: 'SQLite cannot rename a view', names: ['w'] });
    await harness.handlers.renameTable({ ...table, tableKind: 'view' });
    expect(harness.infos).toEqual(['SQLite cannot rename a view']);
    expect(harness.confirmed).toEqual([]);
  });

  it('lets any other failure reach the command guard', async () => {
    const harness = setup({ confirm: 'run' });
    harness.actions.run.mockRejectedValueOnce(new DbError('constraint', 'referenced'));
    await expect(harness.handlers.truncateTable(table)).rejects.toThrow('referenced');
    expect(harness.refresh).not.toHaveBeenCalled();
  });

  it('ignores missing and unrelated targets', async () => {
    const harness = setup({ confirm: 'run', names: ['x'] });
    const connection: TreeNode = { kind: 'connection', connectionId: 'c1' };
    await harness.handlers.dropTable(database);
    await harness.handlers.dropTable();
    await harness.handlers.dropDatabase(table);
    await harness.handlers.dropSchema(connection);
    await harness.handlers.dropObject(table);
    await harness.handlers.createSchema(connection);
    await harness.handlers.createTable(table);
    await harness.handlers.createTable({
      kind: 'group',
      group: 'views',
      connectionId: 'c1',
      scope: {},
    });
    await harness.handlers.createDatabase('c1');
    await harness.handlers.renameTable(schema);
    expect(harness.actions.sqlOf).not.toHaveBeenCalled();
  });
});

describe('names', () => {
  it('trims the typed name and validates it for the driver', async () => {
    const harness = setup({ confirm: 'run', names: ['  invoices  '] });
    await harness.handlers.createDatabase({ kind: 'connection', connectionId: 'c1' });
    expect(harness.ran[0]?.action).toEqual({ kind: 'createDatabase', name: 'invoices' });
    const validate = harness.asked[0]?.validate;
    expect(validate?.('')).toBe('empty');
    expect(validate?.('a\u0000')).toBe('nul');
    expect(validate?.('a'.repeat(65))).toBe('max 64');
    expect(validate?.('ok')).toBeUndefined();
  });

  it('stops when the name prompt is cancelled', async () => {
    const harness = setup({ confirm: 'run', names: [undefined] });
    await harness.handlers.createDatabase(database);
    expect(harness.actions.sqlOf).not.toHaveBeenCalled();
  });

  it('starts a rename from the current name and refuses to keep it', async () => {
    const harness = setup({ confirm: 'run', names: ['orders_2024'] });
    await harness.handlers.renameTable(table);
    expect(harness.asked[0]?.value).toBe('orders');
    expect(harness.asked[0]?.validate('orders')).toBe('same');
    expect(harness.ran[0]?.action).toEqual({
      kind: 'renameTable',
      table: { database: 'shop', name: 'orders' },
      relation: 'table',
      newName: 'orders_2024',
    });
    expect(harness.confirmed[0]?.title).toBe('rename orders to orders_2024?');
  });

  it('uses the byte limit of PostgreSQL', async () => {
    const harness = setup({ driver: 'postgres', names: [undefined] });
    await harness.handlers.createSchema(database);
    expect(harness.asked[0]?.validate('я'.repeat(32))).toBe('max 63');
  });
});

describe('databases and schemas', () => {
  it('needs the database name typed back before dropping it', async () => {
    const harness = setup({ confirm: 'run', names: ['shop'] });
    await harness.handlers.dropDatabase(database);
    expect(harness.asked[0]?.title).toBe('type shop');
    expect(harness.asked[0]?.validate('Shop')).toBe('type exactly');
    expect(harness.asked[0]?.validate('shop')).toBeUndefined();
    expect(harness.ran[0]?.action).toEqual({ kind: 'dropDatabase', name: 'shop' });
  });

  it('stops when the typed name is cancelled', async () => {
    const harness = setup({ confirm: 'run', names: [undefined] });
    await harness.handlers.dropDatabase(database);
    expect(harness.actions.sqlOf).not.toHaveBeenCalled();
  });

  it('says a file database has no databases to create', async () => {
    const harness = setup({ driver: 'sqlite', names: ['x'] });
    await harness.handlers.createDatabase({ kind: 'connection', connectionId: 'c1' });
    expect(harness.infos).toEqual(['no databases']);
    expect(harness.asked).toEqual([]);
  });

  it('creates a schema inside the clicked database', async () => {
    const harness = setup({ driver: 'postgres', confirm: 'run', names: ['audit'] });
    await harness.handlers.createSchema(database);
    expect(harness.ran[0]?.action).toEqual({
      kind: 'createSchema',
      database: 'shop',
      name: 'audit',
    });
  });

  it('says a database without schemas has none to create', async () => {
    const harness = setup({ driver: 'mysql', names: ['x'] });
    await harness.handlers.createSchema(database);
    expect(harness.infos).toEqual(['no schemas']);
  });

  it('asks whether to drop a schema with its objects, then for the name', async () => {
    const harness = setup({ driver: 'postgres', confirm: 'run', pick: true, names: ['sales'] });
    await harness.handlers.dropSchema(schema);
    expect(harness.ran[0]?.action).toEqual({
      kind: 'dropSchema',
      database: 'shop',
      name: 'sales',
      cascade: true,
    });
  });

  it('stops when the CASCADE question is dismissed', async () => {
    const harness = setup({
      driver: 'postgres',
      confirm: 'run',
      pick: undefined,
      names: ['sales'],
    });
    await harness.handlers.dropSchema(schema);
    expect(harness.asked).toEqual([]);
    expect(harness.actions.sqlOf).not.toHaveBeenCalled();
  });
});

describe('tables and objects', () => {
  it('opens the designer for a table in a MySQL database, asking nothing', async () => {
    const harness = setup({ confirm: 'run' });
    await harness.handlers.createTable(database);
    expect(harness.designers).toEqual([{ connectionId: 'c1', scope: { database: 'shop' } }]);
    expect(harness.asked).toEqual([]);
    expect(harness.actions.sqlOf).not.toHaveBeenCalled();
  });

  it('puts a new table of a PostgreSQL database into public', async () => {
    const harness = setup({ driver: 'postgres' });
    await harness.handlers.createTable(database);
    expect(harness.designers[0]?.scope).toEqual({ database: 'shop', schema: 'public' });
  });

  it('opens the designer from the Tables folder of a schema', async () => {
    const harness = setup({ driver: 'postgres' });
    await harness.handlers.createTable({
      kind: 'group',
      group: 'tables',
      connectionId: 'c1',
      scope: { database: 'shop', schema: 'sales' },
    });
    expect(harness.designers[0]?.scope).toEqual({ database: 'shop', schema: 'sales' });
  });

  it('opens the designer of a SQLite file without a scope', async () => {
    const harness = setup({ driver: 'sqlite' });
    await harness.handlers.createTable({
      kind: 'group',
      group: 'tables',
      connectionId: 'c1',
      scope: {},
    });
    expect(harness.designers[0]).toEqual({ connectionId: 'c1', scope: {} });
  });

  it('opens an existing table in the designer, but not a view', async () => {
    const harness = setup();
    await harness.handlers.designTable(table);
    expect(harness.designers).toEqual([
      { connectionId: 'c1', scope: { database: 'shop' }, table: 'orders' },
    ]);
    await harness.handlers.designTable({ ...table, tableKind: 'view' });
    await harness.handlers.designTable(database);
    await harness.handlers.designTable();
    expect(harness.designers).toHaveLength(1);
  });

  it('drops a materialized view as one', async () => {
    const harness = setup({ confirm: 'run' });
    await harness.handlers.dropTable({ ...table, tableKind: 'view', materialized: true });
    expect(harness.ran[0]?.action).toMatchObject({ relation: 'materialized-view' });
  });

  it('empties only tables', async () => {
    const harness = setup({ confirm: 'run' });
    await harness.handlers.truncateTable({ ...table, tableKind: 'view' });
    expect(harness.actions.sqlOf).not.toHaveBeenCalled();
    await harness.handlers.truncateTable(table);
    expect(harness.confirmed[0]).toMatchObject({ title: 'truncate orders?', runLabel: 'Empty' });
  });

  it('drops a routine with its signature', async () => {
    const harness = setup({ confirm: 'run' });
    const object = { schema: 's', kind: 'function' as const, name: 'f', signature: 'a int' };
    await harness.handlers.dropObject({ kind: 'object', connectionId: 'c1', object });
    expect(harness.ran[0]?.action).toEqual({ kind: 'dropObject', object });
    expect(harness.confirmed[0]?.title).toBe('drop object f?');
  });
});
