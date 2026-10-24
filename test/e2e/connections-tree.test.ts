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
    ]) {
      for await (const _event of session.execute(sql)) {
        // Draining the stream is what runs the statement.
      }
    }
  } finally {
    await session.close();
  }
}
