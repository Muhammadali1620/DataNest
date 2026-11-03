import * as assert from 'node:assert/strict';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { createBundleSshLoader, type SshModule } from '../../src/services/tunnels';
import { RecordingLogger } from '../helpers/fakes';
import { roundTrip, startEchoServer, startSshServer, testUserKey } from '../helpers/ssh-server';

// The SSH bundle runs on the editor's own Node and crypto (Electron ships BoringSSL,
// not OpenSSL), so it is checked here and not only in unit tests.
describe('SSH bundle', () => {
  // The loader the extension itself uses: a test that unwrapped `{ ssh }` on its own once
  // hid that the real loader handed out the wrapper (the Servers view failed with
  // "openSftp is not a function").
  async function loadSsh(): Promise<SshModule> {
    const extension = vscode.extensions.getExtension('datanest.datanest');
    assert.ok(extension);
    return await createBundleSshLoader(join(extension.extensionPath, 'dist', 'extension.js'))();
  }

  it('loads without native add-ons', async () => {
    const ssh = await loadSsh();
    for (const name of [
      'openTunnel',
      'downloadFiles',
      'openSftp',
      'openShell',
      'execCommand',
      'openExec',
    ]) {
      assert.equal(typeof (ssh as unknown as Record<string, unknown>)[name], 'function', name);
    }
  });

  it('opens a tunnel with a password and with a key inside the editor', async () => {
    const key = testUserKey('phrase');
    const server = await startSshServer({
      users: [
        { name: 'pw', password: 'secret' },
        { name: 'key', publicKey: key.public },
      ],
    });
    const echo = await startEchoServer();
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'datanest-e2e-ssh-'));
    const keyFile = join(dir, 'id');
    writeFileSync(keyFile, key.private);
    try {
      const ssh = await loadSsh();
      const base = {
        target: { host: '127.0.0.1', port: echo.port },
        checkHostKey: () => Promise.resolve(true),
        timeoutMs: 10_000,
      };
      const byPassword = await ssh.openTunnel(
        {
          ...base,
          hops: [
            {
              host: '127.0.0.1',
              port: server.port,
              user: 'pw',
              auth: 'password',
              password: 'secret',
            },
          ],
        },
        new RecordingLogger(),
      );
      assert.equal(await roundTrip(byPassword.port, 'password'), 'password');
      await byPassword.close();
      const byKey = await ssh.openTunnel(
        {
          ...base,
          hops: [
            {
              host: '127.0.0.1',
              port: server.port,
              user: 'key',
              auth: 'key',
              keyFile,
              passphrase: 'phrase',
            },
          ],
        },
        new RecordingLogger(),
      );
      assert.equal(await roundTrip(byKey.port, 'key'), 'key');
      await byKey.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await echo.close();
      await server.close();
    }
  });
});
