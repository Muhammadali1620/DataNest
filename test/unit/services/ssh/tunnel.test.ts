import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  connectConfig,
  defaultAgentSocket,
  describeHostKey,
  expandHome,
  openSshTunnel,
  sshError,
  WINDOWS_AGENT_PIPE,
} from '../../../../src/services/ssh/tunnel';
import type {
  HostKeyCheck,
  HostKeyInfo,
  Tunnel,
  TunnelHop,
  TunnelSpec,
} from '../../../../src/services/tunnels';
import { RecordingLogger } from '../../../helpers/fakes';
import {
  roundTrip,
  startEchoServer,
  startSshServer,
  startTestAgent,
  testUserKey,
  type TestSshServer,
} from '../../../helpers/ssh-server';

const TRUST_ALL: HostKeyCheck = () => Promise.resolve(true);

const hopBase: TunnelHop = { host: '127.0.0.1', port: 22, user: 'deploy', auth: 'password' };

describe('defaultAgentSocket', () => {
  it('uses SSH_AUTH_SOCK wherever it is set', () => {
    expect(defaultAgentSocket('linux', { SSH_AUTH_SOCK: '/tmp/agent' })).toBe('/tmp/agent');
    expect(defaultAgentSocket('win32', { SSH_AUTH_SOCK: '/tmp/agent' })).toBe('/tmp/agent');
  });

  it('falls back to the OpenSSH pipe on Windows only', () => {
    expect(defaultAgentSocket('win32', {})).toBe(WINDOWS_AGENT_PIPE);
    expect(defaultAgentSocket('darwin', { SSH_AUTH_SOCK: '' })).toBeUndefined();
    expect(defaultAgentSocket('linux', {})).toBeUndefined();
  });
});

describe('expandHome', () => {
  it('expands a leading tilde and leaves other paths alone', () => {
    expect(expandHome('~', '/home/me')).toBe('/home/me');
    expect(expandHome('~/.ssh/id', '/home/me')).toBe('/home/me/.ssh/id');
    expect(expandHome('~\\.ssh\\id', 'C:\\Users\\me')).toBe('C:\\Users\\me\\.ssh\\id');
    expect(expandHome('/etc/key', '/home/me')).toBe('/etc/key');
    expect(expandHome('~other/key', '/home/me')).toBe('~other/key');
  });
});

describe('describeHostKey', () => {
  it('reads the algorithm from the blob and prints an OpenSSH fingerprint', () => {
    const name = Buffer.from('ssh-ed25519');
    const blob = Buffer.concat([Buffer.from([0, 0, 0, name.length]), name, Buffer.alloc(36, 7)]);
    const info = describeHostKey('db', 2222, blob);
    expect(info).toMatchObject({ host: 'db', port: 2222, algorithm: 'ssh-ed25519' });
    expect(info.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('survives a blob too short to name its algorithm', () => {
    expect(describeHostKey('db', 22, Buffer.from([0, 0, 0, 99])).algorithm).toBe('?');
    expect(describeHostKey('db', 22, Buffer.alloc(0)).algorithm).toBe('?');
  });
});

describe('connectConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'datanest-key-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('sends only the password, and allows keyboard-interactive for it', async () => {
    const config = await connectConfig({ ...hopBase, password: 'pw' }, 5000);
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 22,
      username: 'deploy',
      password: 'pw',
      tryKeyboard: true,
      readyTimeout: 5000,
    });
    expect(config.privateKey).toBeUndefined();
    expect(config.agent).toBeUndefined();
  });

  it('reads the key file and passes the passphrase only when there is one', async () => {
    const file = join(dir, 'id');
    writeFileSync(file, 'KEY');
    const withPhrase = await connectConfig(
      { ...hopBase, auth: 'key', keyFile: file, passphrase: 'pp', password: 'ignored' },
      5000,
    );
    expect(withPhrase.privateKey?.toString()).toBe('KEY');
    expect(withPhrase.passphrase).toBe('pp');
    expect(withPhrase.password).toBeUndefined();
    const without = await connectConfig({ ...hopBase, auth: 'key', keyFile: file }, 5000);
    expect(without.passphrase).toBeUndefined();
  });

  it('reports a key file that cannot be read', async () => {
    await expect(
      connectConfig({ ...hopBase, auth: 'key', keyFile: join(dir, 'missing') }, 5000),
    ).rejects.toMatchObject({
      code: 'not-found',
      message: expect.stringContaining('missing') as unknown,
    });
  });

  it('uses the given agent socket, else the usual one, else refuses', async () => {
    const own = await connectConfig({ ...hopBase, auth: 'agent', agentSocket: '/run/a' }, 1, {
      platform: 'linux',
      env: {},
    });
    expect(own.agent).toBe('/run/a');
    const usual = await connectConfig({ ...hopBase, auth: 'agent' }, 1, {
      platform: 'linux',
      env: { SSH_AUTH_SOCK: '/tmp/s' },
    });
    expect(usual.agent).toBe('/tmp/s');
    await expect(
      connectConfig({ ...hopBase, auth: 'agent' }, 1, { platform: 'linux', env: {} }),
    ).rejects.toMatchObject({
      code: 'auth-failed',
      message: expect.stringContaining('agent') as unknown,
    });
  });
});

describe('sshError', () => {
  const hop: TunnelHop = { ...hopBase, host: 'bastion' };

  it('names a refused host key first, whatever ssh2 says', () => {
    const error = sshError(hop, Object.assign(new Error('x'), { level: 'client-socket' }), true);
    expect(error).toMatchObject({ code: 'permission-denied' });
    expect(error.message).toContain('bastion:22');
  });

  it('maps login failures, timeouts and passphrase problems', () => {
    const auth = Object.assign(new Error('All methods failed'), { level: 'client-authentication' });
    expect(sshError(hop, auth, false)).toMatchObject({ code: 'auth-failed' });
    const timeout = Object.assign(new Error('Timed out'), { level: 'client-timeout' });
    expect(sshError(hop, timeout, false)).toMatchObject({ code: 'timeout' });
    expect(
      sshError(
        hop,
        new Error('Encrypted private OpenSSH key detected, but no passphrase given'),
        false,
      ).message,
    ).toContain('protected by a passphrase');
    expect(
      sshError({ ...hop, passphrase: 'bad' }, new Error('bad passphrase'), false).message,
    ).toContain('Wrong passphrase');
    expect(sshError(hop, new Error('Cannot parse privateKey: nope'), false)).toMatchObject({
      code: 'auth-failed',
    });
  });

  it('treats anything else as a failed connection and keeps the cause', () => {
    const cause = new Error('connect ECONNREFUSED');
    const error = sshError(hop, cause, false);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ code: 'connection-failed', cause });
    expect(error.message).toContain('ECONNREFUSED');
  });
});

describe('openSshTunnel', () => {
  const logger = new RecordingLogger();
  let echo: Awaited<ReturnType<typeof startEchoServer>>;
  const servers: TestSshServer[] = [];
  const tunnels: Tunnel[] = [];
  let dir: string;

  async function server(...args: Parameters<typeof startSshServer>): Promise<TestSshServer> {
    const started = await startSshServer(...args);
    servers.push(started);
    return started;
  }

  function spec(hops: TunnelHop[], overrides: Partial<TunnelSpec> = {}): TunnelSpec {
    return {
      hops,
      target: { host: '127.0.0.1', port: echo.port },
      checkHostKey: TRUST_ALL,
      timeoutMs: 5000,
      ...overrides,
    };
  }

  async function open(value: TunnelSpec): Promise<Tunnel> {
    const tunnel = await openSshTunnel(value, logger);
    tunnels.push(tunnel);
    return tunnel;
  }

  beforeEach(async () => {
    echo = await startEchoServer();
    dir = mkdtempSync(join(tmpdir(), 'datanest-tunnel-'));
  });

  afterEach(async () => {
    for (const tunnel of tunnels.splice(0)) {
      await tunnel.close();
    }
    for (const started of servers.splice(0)) {
      await started.close();
    }
    await echo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('logs in with a password and forwards a local port to the target', async () => {
    const ssh = await server({ users: [{ name: 'deploy', password: 'pw' }] });
    const tunnel = await open(spec([{ ...hopBase, port: ssh.port, password: 'pw' }]));
    expect(tunnel.port).toBeGreaterThan(0);
    expect(await roundTrip(tunnel.port, 'hello')).toBe('hello');
    expect(await roundTrip(tunnel.port, 'again')).toBe('again');
    expect(ssh.forwards).toEqual([`127.0.0.1:${echo.port}`, `127.0.0.1:${echo.port}`]);
    expect(tunnel.forwardError()).toBeUndefined();
  });

  it('answers a keyboard-interactive password prompt', async () => {
    const ssh = await server({ users: [{ name: 'deploy', password: 'pw', keyboardOnly: true }] });
    const tunnel = await open(spec([{ ...hopBase, port: ssh.port, password: 'pw' }]));
    expect(await roundTrip(tunnel.port, 'kbd')).toBe('kbd');
    expect(ssh.logins).toEqual(['deploy']);
  });

  it('rejects a wrong password as a failed login', async () => {
    const ssh = await server({ users: [{ name: 'deploy', password: 'pw' }] });
    await expect(
      open(spec([{ ...hopBase, port: ssh.port, password: 'nope' }])),
    ).rejects.toMatchObject({
      code: 'auth-failed',
      message: expect.stringContaining('deploy@') as unknown,
    });
  });

  it('logs in with an encrypted key and its passphrase', async () => {
    const key = testUserKey('secret phrase');
    const file = join(dir, 'id_ed25519');
    writeFileSync(file, key.private);
    const ssh = await server({ users: [{ name: 'deploy', publicKey: key.public }] });
    const hop: TunnelHop = { ...hopBase, port: ssh.port, auth: 'key', keyFile: file };
    const tunnel = await open(spec([{ ...hop, passphrase: 'secret phrase' }]));
    expect(await roundTrip(tunnel.port, 'key')).toBe('key');

    await expect(open(spec([hop]))).rejects.toMatchObject({
      code: 'auth-failed',
      message: expect.stringContaining('protected by a passphrase') as unknown,
    });
    await expect(open(spec([{ ...hop, passphrase: 'wrong' }]))).rejects.toMatchObject({
      code: 'auth-failed',
      message: expect.stringContaining('Wrong passphrase') as unknown,
    });
  });

  it('refuses a key the server does not know', async () => {
    const allowed = testUserKey();
    const other = testUserKey();
    const file = join(dir, 'other');
    writeFileSync(file, other.private);
    const ssh = await server({ users: [{ name: 'deploy', publicKey: allowed.public }] });
    await expect(
      open(spec([{ ...hopBase, port: ssh.port, auth: 'key', keyFile: file }])),
    ).rejects.toMatchObject({ code: 'auth-failed' });
  });

  it('logs in through an SSH agent', async () => {
    const key = testUserKey();
    const agent = await startTestAgent(key.private);
    try {
      const ssh = await server({ users: [{ name: 'deploy', publicKey: key.public }] });
      const tunnel = await open(
        spec([{ ...hopBase, port: ssh.port, auth: 'agent', agentSocket: agent.socket }]),
      );
      expect(await roundTrip(tunnel.port, 'agent')).toBe('agent');
    } finally {
      await agent.close();
    }
  });

  it('asks about the host key and stops when it is not trusted', async () => {
    const ssh = await server({ users: [{ name: 'deploy', password: 'pw' }] });
    const seen: HostKeyInfo[] = [];
    const refuse: HostKeyCheck = (key) => {
      seen.push(key);
      return Promise.resolve(false);
    };
    await expect(
      open(spec([{ ...hopBase, port: ssh.port, password: 'pw' }], { checkHostKey: refuse })),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(seen).toEqual([
      {
        host: '127.0.0.1',
        port: ssh.port,
        algorithm: 'ssh-ed25519',
        fingerprint: ssh.fingerprint,
      },
    ]);
    expect(ssh.logins).toEqual([]);
  });

  it('treats a failing host key check as a refusal', async () => {
    const ssh = await server({ users: [{ name: 'deploy', password: 'pw' }] });
    await expect(
      open(
        spec([{ ...hopBase, port: ssh.port, password: 'pw' }], {
          checkHostKey: () => Promise.reject(new Error('dialog crashed')),
        }),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('reaches the second server through the first one', async () => {
    const outer = await server({ users: [{ name: 'jump', password: 'j' }] });
    const inner = await server({ users: [{ name: 'deploy', password: 'pw' }] });
    const checked: number[] = [];
    const tunnel = await open(
      spec(
        [
          { ...hopBase, port: outer.port, user: 'jump', password: 'j' },
          { ...hopBase, port: inner.port, password: 'pw' },
        ],
        {
          checkHostKey: (key) => {
            checked.push(key.port);
            return Promise.resolve(true);
          },
        },
      ),
    );
    expect(await roundTrip(tunnel.port, 'chain')).toBe('chain');
    expect(outer.forwards).toEqual([`127.0.0.1:${inner.port}`]);
    expect(inner.forwards).toEqual([`127.0.0.1:${echo.port}`]);
    expect(checked).toEqual([outer.port, inner.port]);
  });

  it('says which server could not reach the next one', async () => {
    const outer = await server({
      users: [{ name: 'jump', password: 'j' }],
      refuse: () => true,
    });
    await expect(
      open(
        spec([
          { ...hopBase, port: outer.port, user: 'jump', password: 'j' },
          { ...hopBase, host: 'inner.example', port: 2200, password: 'pw' },
        ]),
      ),
    ).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('cannot reach inner.example:2200') as unknown,
    });
  });

  it('closes the first login when a later one fails', async () => {
    const outer = await server({ users: [{ name: 'jump', password: 'j' }] });
    const inner = await server({ users: [{ name: 'deploy', password: 'pw' }] });
    await expect(
      open(
        spec([
          { ...hopBase, port: outer.port, user: 'jump', password: 'j' },
          { ...hopBase, port: inner.port, password: 'wrong' },
        ]),
      ),
    ).rejects.toMatchObject({ code: 'auth-failed' });
    expect(outer.logins).toEqual(['jump']);
  });

  it('remembers why a forwarded connection failed', async () => {
    const ssh = await server({ users: [{ name: 'deploy', password: 'pw' }], refuse: () => true });
    const tunnel = await open(spec([{ ...hopBase, port: ssh.port, password: 'pw' }]));
    expect(await roundTrip(tunnel.port, 'lost')).toBe('');
    await vi.waitFor(() => {
      expect(tunnel.forwardError()).toMatchObject({
        code: 'connection-failed',
        message: expect.stringContaining(`cannot reach 127.0.0.1:${echo.port}`) as unknown,
      });
    });
  });

  it('reports an SSH server that does not listen', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve) => {
      probe.close(() => {
        resolve();
      });
    });
    await expect(open(spec([{ ...hopBase, port, password: 'pw' }]))).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining(`127.0.0.1:${port}`) as unknown,
    });
  });

  it('gives up on a server that never answers', async () => {
    const silent = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const port = (silent.address() as { port: number }).port;
    try {
      await expect(
        open(spec([{ ...hopBase, port, password: 'pw' }], { timeoutMs: 50 })),
      ).rejects.toMatchObject({ code: 'timeout' });
    } finally {
      silent.close();
    }
  });

  it('settles `closed` when the SSH server drops the connection', async () => {
    const ssh = await server({ users: [{ name: 'deploy', password: 'pw' }] });
    const tunnel = await open(spec([{ ...hopBase, port: ssh.port, password: 'pw' }]));
    ssh.kick();
    await tunnel.closed;
    await expect(roundTrip(tunnel.port, 'x')).rejects.toThrow();
  });

  it('closes the local port and every forwarded connection on close', async () => {
    const ssh = await server({ users: [{ name: 'deploy', password: 'pw' }] });
    const tunnel = await openSshTunnel(
      spec([{ ...hopBase, port: ssh.port, password: 'pw' }]),
      logger,
    );
    expect(await roundTrip(tunnel.port, 'bye')).toBe('bye');
    await tunnel.close();
    await tunnel.close();
    await expect(roundTrip(tunnel.port, 'x')).rejects.toThrow();
  });

  it('needs at least one server', async () => {
    await expect(open(spec([]))).rejects.toMatchObject({ code: 'internal' });
  });
});
