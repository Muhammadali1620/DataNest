import * as assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { SshModule } from '../../src/services/tunnels';
import { RecordingLogger } from '../helpers/fakes';
import { roundTrip, startEchoServer, startSshServer, testUserKey } from '../helpers/ssh-server';

// The SSH bundle runs on the editor's own Node and crypto (Electron ships BoringSSL,
// not OpenSSL), so it is checked here and not only in unit tests.
describe('SSH bundle', () => {
  function loadSsh(): SshModule {
    const extension = vscode.extensions.getExtension('datanest.datanest');
    assert.ok(extension);
    const load = createRequire(join(extension.extensionPath, 'package.json'));
    return (load('./dist/ssh.js') as { ssh: SshModule }).ssh;
  }

  it('loads without native add-ons', () => {
    assert.equal(typeof loadSsh().openTunnel, 'function');
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
      const ssh = loadSsh();
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
