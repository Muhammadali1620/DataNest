// The Connections view in a real editor, against a real SQLite file: the tree
// walks from the connection down to the columns through the shipped driver bundle.

import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';
const VIEW_ID = 'datanest.connections';

describe('connections view', () => {
  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  });

  it('is registered and can be focused', async () => {
    // Focusing the view is what activates the extension for a real user.
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    const all = await vscode.commands.getCommands(true);
    assert.ok(all.includes(`${VIEW_ID}.focus`), 'the view command is missing');
  });

  it('hides system objects by default and can be switched at runtime', async () => {
    const config = vscode.workspace.getConfiguration('datanest');
    assert.equal(config.get('showSystemObjects'), false);
    try {
      await config.update('showSystemObjects', true, vscode.ConfigurationTarget.Global);
      assert.equal(vscode.workspace.getConfiguration('datanest').get('showSystemObjects'), true);
    } finally {
      await vscode.workspace
        .getConfiguration('datanest')
        .update('showSystemObjects', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.equal(vscode.workspace.getConfiguration('datanest').get('showSystemObjects'), false);
  });

  it('registers every tree command', async () => {
    const all = await vscode.commands.getCommands(true);
    for (const id of [
      'datanest.connections.connect',
      'datanest.connections.disconnect',
      'datanest.tree.refresh',
      'datanest.tree.copyName',
      'datanest.table.open',
      'datanest.object.showDefinition',
      'datanest.database.create',
      'datanest.database.drop',
      'datanest.schema.create',
      'datanest.schema.drop',
      'datanest.table.create',
      'datanest.table.design',
      'datanest.table.drop',
      'datanest.table.rename',
      'datanest.table.truncate',
      'datanest.object.drop',
      'datanest.object.edit',
      'datanest.object.apply',
      'datanest.table.generateSelect',
      'datanest.table.generateInsert',
      'datanest.table.generateUpdate',
      'datanest.table.generateDelete',
    ]) {
      assert.ok(all.includes(id), `${id} is not registered`);
    }
  });

  it('opening a table without a node does nothing', async () => {
    // The command is driven by the tree; from the palette there is no table.
    await vscode.commands.executeCommand('datanest.table.open');
  });

  it('showing DDL without a node does nothing and opens no editor', async () => {
    // Only new query documents count: output channels come and go on their own.
    const queries = () =>
      vscode.workspace.textDocuments.filter((document) => document.uri.scheme === 'untitled')
        .length;
    const before = queries();
    await vscode.commands.executeCommand('datanest.object.showDefinition');
    assert.equal(queries(), before);
  });

  it('structure commands without a node ask nothing and change nothing', async () => {
    // From the palette there is no node: no prompt may open, so these return at once.
    for (const id of [
      'datanest.database.drop',
      'datanest.schema.drop',
      'datanest.table.drop',
      'datanest.table.rename',
      'datanest.table.truncate',
      'datanest.table.design',
      'datanest.object.drop',
      'datanest.object.edit',
      'datanest.table.generateSelect',
      'datanest.table.generateDelete',
    ]) {
      await vscode.commands.executeCommand(id);
    }
  });

  it('refreshing the whole tree works without a selected node', async () => {
    // The view title button passes no argument; it must not fail.
    await vscode.commands.executeCommand('datanest.tree.refresh');
  });

  it('copying a name does nothing when nothing is selected', async () => {
    await vscode.env.clipboard.writeText('untouched');
    await vscode.commands.executeCommand('datanest.tree.copyName');
    assert.equal(await vscode.env.clipboard.readText(), 'untouched');
  });

  it('copies the name of a node it is given', async () => {
    await vscode.commands.executeCommand('datanest.tree.copyName', {
      kind: 'table',
      connectionId: 'c1',
      scope: { database: 'app' },
      name: 'orders',
      tableKind: 'table',
    });
    assert.equal(await vscode.env.clipboard.readText(), 'orders');
  });
});

describe('tree over a real SQLite database', () => {
  let dir: string;
  let file: string;

  before(async () => {
    await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
    dir = mkdtempSync(join(tmpdir(), 'datanest-e2e-tree-'));
    file = join(dir, 'tree.db');
    await seed(file);
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads tables, views and columns the way the tree does', async () => {
    const session = await openSqlite(file);
    try {
      const tables = await session.metadata.listTables({});
      const byName = new Map(tables.map((table) => [table.name, table.kind]));
      assert.equal(byName.get('customers'), 'table');
      assert.equal(byName.get('active'), 'view');

      const columns = await session.metadata.listColumns({ name: 'customers' });
      assert.deepEqual(
        columns.map((column) => column.name),
        ['id', 'email'],
      );
      assert.equal(columns[0]?.primaryKey, true);
      assert.equal(columns[1]?.nullable, false);

      // A file database has no databases to list: the tree shows groups directly.
      assert.deepEqual(await session.metadata.listDatabases(), []);

      // Indexes and triggers, which the tree lists inside a table.
      const indexes = await session.metadata.listIndexes({ name: 'customers' });
      assert.deepEqual(
        indexes.map((index) => index.name),
        ['ix_customers_email'],
      );
      assert.deepEqual(await session.metadata.listObjects({}, 'trigger'), [
        { name: 'customers_audit', kind: 'trigger', table: 'customers' },
      ]);

      // "Show DDL" reads through the shipped bundle as well.
      assert.deepEqual(await session.metadata.getDefinition({ kind: 'view', name: 'active' }), [
        'CREATE VIEW active AS SELECT id FROM customers',
      ]);
    } finally {
      await session.close();
    }
  });
});

interface SqliteSessionLike {
  execute(sql: string): AsyncIterable<{ kind: string }>;
  metadata: {
    listDatabases(): Promise<string[]>;
    listTables(scope: Record<string, unknown>): Promise<{ name: string; kind: string }[]>;
    listColumns(
      table: Record<string, unknown>,
    ): Promise<{ name: string; dataType: string; nullable: boolean; primaryKey: boolean }[]>;
    getDefinition(object: Record<string, unknown>): Promise<string[]>;
    listIndexes(table: Record<string, unknown>): Promise<{ name: string }[]>;
    listObjects(scope: Record<string, unknown>, kind: string): Promise<unknown[]>;
  };
  close(): Promise<void>;
}

async function openSqlite(file: string): Promise<SqliteSessionLike> {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension);
  const bundle = join(extension.extensionPath, 'dist', 'drivers', 'sqlite.js');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const loaded = require(bundle) as {
    driver: { openSession(config: Record<string, unknown>): Promise<SqliteSessionLike> };
  };
  return await loaded.driver.openSession({
    id: 'e2e-tree',
    name: 'e2e tree',
    driver: 'sqlite',
    file,
  });
}

async function seed(file: string): Promise<void> {
  const session = await openSqlite(file);
  try {
    for (const sql of [
      'CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT NOT NULL)',
      "INSERT INTO customers VALUES (1, 'a@example.com')",
      'CREATE VIEW active AS SELECT id FROM customers',
      'CREATE INDEX ix_customers_email ON customers (email)',
      'CREATE TRIGGER customers_audit AFTER INSERT ON customers BEGIN SELECT 1; END',
    ]) {
      for await (const _event of session.execute(sql)) {
        // Draining the stream is what runs the statement.
      }
    }
  } finally {
    await session.close();
  }
}
