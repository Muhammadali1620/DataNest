// Confirms the V0.12 research inside a real editor on every CI OS: node:sqlite
// works in the extension host's Node via worker_threads, loaded from the same
// dist/drivers bundles the packaged extension ships (D5, D23).

import * as assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

interface SqliteDriverModule {
  driver: {
    id: string;
    openSession(config: { id: string; name: string; driver: string; file: string }): Promise<{
      execute(
        sql: string,
      ): AsyncIterable<
        | { kind: 'columns'; columns: { name: string }[] }
        | { kind: 'rows'; rows: unknown[][] }
        | { kind: 'done'; affectedRows?: number }
      >;
      close(): Promise<void>;
    }>;
  };
}

describe('sqlite driver in the real editor', () => {
  let dir: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'datanest-e2e-sqlite-'));
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a database through the shipped bundle and runs SQL', async function () {
    this.timeout(30_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
    const bundle = join(extension.extensionPath, 'dist', 'drivers', 'sqlite.js');
    // The driver is loaded exactly like DriverRegistry does it: a runtime require
    // of the separate bundle (ARCHITECTURE.md §7).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { driver } = require(bundle) as SqliteDriverModule;
    assert.equal(driver.id, 'sqlite');

    const session = await driver.openSession({
      id: 'e2e',
      name: 'e2e',
      driver: 'sqlite',
      file: join(dir, 'e2e.db'),
    });
    try {
      const events: unknown[] = [];
      for await (const event of session.execute('CREATE TABLE t (id INTEGER PRIMARY KEY)')) {
        events.push(event);
      }
      for await (const event of session.execute('INSERT INTO t VALUES (1), (2)')) {
        if (event.kind === 'done') {
          assert.equal(event.affectedRows, 2);
        }
      }
      const rows: unknown[][] = [];
      let columns: string[] = [];
      for await (const event of session.execute('SELECT id FROM t ORDER BY id')) {
        if (event.kind === 'columns') {
          columns = event.columns.map((c) => c.name);
        }
        if (event.kind === 'rows') {
          rows.push(...event.rows);
        }
      }
      assert.deepEqual(columns, ['id']);
      assert.deepEqual(rows, [[1], [2]]);
    } finally {
      await session.close();
    }
  });
});
