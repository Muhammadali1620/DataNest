import * as assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { ACTIVATION_MS } from '../perf/budgets';

const EXTENSION_ID = 'datanest.datanest';

interface Manifest {
  contributes: { commands: { command: string }[] };
}

function extension(): vscode.Extension<unknown> {
  const found = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(found, `${EXTENSION_ID} is not installed in the test host`);
  return found;
}

// Mocha loads every test file before running any test, so this is captured before
// other files activate the extension, whatever order they run in.
const activeAtStartup = vscode.extensions.getExtension(EXTENSION_ID)?.isActive;

// A root hook runs before every suite of every file, so this is the first activation,
// whichever suite would otherwise activate the extension first (V9.1).
let activationMs: number | undefined;
before(async () => {
  const started = performance.now();
  await vscode.extensions.getExtension(EXTENSION_ID)?.activate();
  activationMs = Math.round(performance.now() - started);
  const line =
    `First activation in VS Code ${vscode.version} (${process.platform}): ` +
    `${activationMs} ms (budget ${ACTIVATION_MS} ms)`;
  // eslint-disable-next-line no-console -- the e2e log keeps the number for local runs
  console.log(line);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, `${line}\n`);
  }
});

describe('DataNest extension', () => {
  it('is installed in the test host', () => {
    extension();
  });

  it('is not activated on startup', () => {
    // Activation must be lazy (ARCHITECTURE.md §7).
    assert.equal(activeAtStartup, false);
  });

  it('activates without errors', async () => {
    await extension().activate();
    assert.equal(extension().isActive, true);
  });

  it('activates within the performance budget', () => {
    assert.ok(activationMs !== undefined, 'the root hook did not activate the extension');
    assert.ok(
      activationMs <= ACTIVATION_MS,
      `first activation took ${activationMs} ms, budget ${ACTIVATION_MS} ms`,
    );
  });

  it('installs the translator for the messages of its services (V9.2)', () => {
    // The test host shares the extension host's global object, as the driver bundles do.
    const translate = (globalThis as Record<symbol, unknown>)[Symbol.for('datanest.translator')];
    assert.equal(typeof translate, 'function');
    // The test host is English: the template comes back with its values in place.
    const english = (translate as (template: string, args: unknown[]) => string)(
      'Connection "{0}" does not exist',
      ['prod'],
    );
    assert.equal(english, 'Connection "prod" does not exist');
  });

  it('registers every command from package.json', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const { contributes } = extension().packageJSON as Manifest;
    const missing = contributes.commands.map((c) => c.command).filter((id) => !registered.has(id));
    assert.deepEqual(missing, []);
  });

  it('opens its activity bar container and the connections view', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.datanest');
    await vscode.commands.executeCommand('datanest.connections.focus');
  });

  it('shows the logs', async () => {
    await vscode.commands.executeCommand('datanest.logs.show');
  });

  it('follows log level changes at runtime', async () => {
    const config = vscode.workspace.getConfiguration('datanest');
    assert.equal(config.get('logLevel'), 'info');
    await config.update('logLevel', 'debug', vscode.ConfigurationTarget.Global);
    try {
      assert.equal(vscode.workspace.getConfiguration('datanest').get('logLevel'), 'debug');
      await vscode.commands.executeCommand('datanest.logs.show');
    } finally {
      await config.update('logLevel', undefined, vscode.ConfigurationTarget.Global);
    }
  });
});
