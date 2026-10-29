// The shipped Elasticsearch bundle inside a real editor (V7.8): its own HTTP client loads
// in the extension host's Node on every CI OS, and a refused connect reaches the
// extension as its own DbError with the code intact (D82).

import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';

const EXTENSION_ID = 'datanest.datanest';

interface ElasticsearchDriverModule {
  driver: {
    id: string;
    openSession(config: {
      id: string;
      name: string;
      driver: string;
      host: string;
      port: number;
      options: { connectTimeout: number };
    }): Promise<{ close(): Promise<void> }>;
  };
}

describe('elasticsearch driver in the real editor', () => {
  it('loads from dist/drivers and fails a refused connect with a branded DbError', async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, 'the extension is not installed');
    const bundle = join(extension.extensionPath, 'dist', 'drivers', 'elasticsearch.js');
    // The driver is loaded exactly like DriverRegistry does it: a runtime require.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { driver } = require(bundle) as ElasticsearchDriverModule;
    assert.equal(driver.id, 'elasticsearch');
    // Port 1 refuses at once on any machine.
    const failure: unknown = await driver
      .openSession({
        id: 'e2e',
        name: 'e2e',
        driver: 'elasticsearch',
        host: '127.0.0.1',
        port: 1,
        options: { connectTimeout: 3 },
      })
      .then(
        async (session) => {
          await session.close();
          return undefined;
        },
        (error: unknown) => error,
      );
    assert.ok(failure instanceof Error, 'the connect did not fail');
    assert.equal((failure as { code?: unknown }).code, 'connection-failed');
    assert.equal(
      (failure as unknown as Record<symbol, unknown>)[Symbol.for('datanest.DbError')],
      true,
    );
  });
});
