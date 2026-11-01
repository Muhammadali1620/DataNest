// The public API in a real editor (V12.7): another extension reaches it through the exports
// of `datanest.datanest`. The test host plays that extension.

import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { DataNestApi, PluginDriver, PluginSession } from '../../src/api/types';

const EXTENSION_ID = 'datanest.datanest';

function driver(id: string): PluginDriver {
  return {
    id,
    label: 'E2E database',
    fields: ['host', 'port'],
    openSession: (): Promise<PluginSession> =>
      Promise.resolve({
        execute: () => ({
          async *[Symbol.asyncIterator]() {
            // No events: the adapter adds the final `done`.
          },
        }),
        metadata: {
          listTables: () => Promise.resolve([]),
          listColumns: () => Promise.resolve([]),
        },
        close: () => Promise.resolve(),
      }),
  };
}

async function api(): Promise<DataNestApi> {
  const extension = vscode.extensions.getExtension<DataNestApi>(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed in the test host`);
  return await extension.activate();
}

describe('public API', () => {
  it('is what activating the extension returns', async () => {
    const exported = await api();
    assert.equal(exported.apiVersion, 1);
    assert.equal(typeof exported.registerDriver, 'function');
    assert.equal(typeof exported.registeredDrivers, 'function');
  });

  it('registers a driver, refuses a repeat and takes it back', async () => {
    const exported = await api();
    const registration = exported.registerDriver(driver('e2e.one'));
    try {
      assert.ok(exported.registeredDrivers().includes('e2e.one'));
      assert.throws(() => exported.registerDriver(driver('e2e.one')), /already registered/u);
    } finally {
      registration.dispose();
    }
    assert.ok(!exported.registeredDrivers().includes('e2e.one'));
  });

  it('refuses a driver with a bad id', async () => {
    const exported = await api();
    assert.throws(() => exported.registerDriver(driver('Bad Id')), /not valid/u);
  });

  it('cannot be changed by a plugin', async () => {
    const exported = await api();
    assert.throws(() => {
      (exported as { apiVersion: number }).apiVersion = 2;
    });
    assert.equal(exported.apiVersion, 1);
  });

  it('adds the command that makes a connection of such a driver', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('datanest.connections.addPlugin'));
  });
});
