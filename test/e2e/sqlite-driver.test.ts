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
    openSession(config: {
      id: string;
      name: string;
      driver: string;
      file: string;
      readOnly?: boolean;
    }): Promise<{
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
    // Windows keeps the file locked for a moment after the worker that had it open ends.
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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

  it('opens a read-only session that the Node of the editor keeps read-only', async function () {
    this.timeout(30_000);
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { driver } = require(
      join(extension.extensionPath, 'dist', 'drivers', 'sqlite.js'),
    ) as SqliteDriverModule;
    const file = join(dir, 'e2e.db');
    const session = await driver.openSession({
      id: 'e2e-ro',
      name: 'e2e-ro',
      driver: 'sqlite',
      file,
      readOnly: true,
    });
    try {
      const rows: unknown[][] = [];
      for await (const event of session.execute('SELECT count(*) FROM t')) {
        if (event.kind === 'rows') {
          rows.push(...event.rows);
        }
      }
      assert.deepEqual(rows, [[2]]);
      await assert.rejects(async () => {
        for await (const _event of session.execute('INSERT INTO t VALUES (3)')) {
          // The write must fail.
        }
      }, /readonly|read-only/i);
    } finally {
      await session.close();
    }
  });
});
