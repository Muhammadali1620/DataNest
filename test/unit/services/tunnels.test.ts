import { connect } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ConnectionInput } from '../../../src/shared/connection';
import {
  type HostKeyCheck,
  SSH_TIMEOUT_MS,
  type SshModule,
  TunnelPool,
  type TunnelSpec,
  tunnelKeyOf,
  tunnelSpecOf,
} from '../../../src/services/tunnels';
import { RecordingLogger } from '../../helpers/fakes';
import { FakeTunnel } from '../../helpers/fake-tunnels';
import { startEchoServer, startSocksProxy } from '../../helpers/proxy-servers';

const check: HostKeyCheck = () => Promise.resolve(true);

const base: ConnectionInput = {
  name: 'Prod',
  driver: 'postgres',
  host: 'db.internal',
  user: 'app',
  ssh: { id: 'main', host: 'bastion', port: 2222, user: 'deploy', auth: 'password' },
};

describe('tunnelSpecOf', () => {
  it('waits for each SSH hop as long as the connection says (V4.9)', () => {
    expect(tunnelSpecOf({ ...base, options: { connectTimeout: 25 } }, {}, check)?.timeoutMs).toBe(
      25_000,
    );
  });

  it('is undefined for a direct connection', () => {
    expect(tunnelSpecOf({ ...base, ssh: undefined }, {}, check)).toBeUndefined();
    expect(tunnelSpecOf({ ...base, host: undefined }, {}, check)).toBeUndefined();
  });

  it('targets the database host and default port and joins the hop secrets', () => {
    expect(tunnelSpecOf(base, { main: { password: 'pw', passphrase: 'unused' } }, check)).toEqual({
      hops: [{ host: 'bastion', port: 2222, user: 'deploy', auth: 'password', password: 'pw' }],
      target: { host: 'db.internal', port: 5432 },
      checkHostKey: check,
      timeoutMs: SSH_TIMEOUT_MS,
    });
  });

  it('passes only what the chosen method uses', () => {
    const key = tunnelSpecOf(
      { ...base, ssh: { id: 'main', host: 'b', user: 'u', auth: 'key', keyFile: '~/.ssh/id' } },
      { main: { password: 'unused', passphrase: 'pp' } },
      check,
    );
    expect(key?.hops).toEqual([
      { host: 'b', port: 22, user: 'u', auth: 'key', keyFile: '~/.ssh/id', passphrase: 'pp' },
    ]);
    const agent = tunnelSpecOf(
      { ...base, ssh: { id: 'main', host: 'b', user: 'u', auth: 'agent', agentSocket: '/s' } },
      { main: { password: 'unused' } },
      check,
    );
    expect(agent?.hops).toEqual([
      { host: 'b', port: 22, user: 'u', auth: 'agent', agentSocket: '/s' },
    ]);
  });

  it('works without stored secrets', () => {
    expect(tunnelSpecOf(base, {}, check)?.hops[0]).not.toHaveProperty('password');
  });
});

describe('tunnelSpecOf with jump hosts', () => {
  it('lists the jumps before the server, each with its own secrets', () => {
    const spec = tunnelSpecOf(
      {
        ...base,
        ssh: {
          id: 'main',
          host: 'inner',
          user: 'deploy',
          auth: 'password',
          jumps: [{ id: 'j', host: 'edge', port: 2200, user: 'jump', auth: 'password' }],
        },
      },
      { j: { password: 'jp' }, main: { password: 'mp' } },
      check,
    );
    expect(spec?.hops).toEqual([
      { host: 'edge', port: 2200, user: 'jump', auth: 'password', password: 'jp' },
      { host: 'inner', port: 22, user: 'deploy', auth: 'password', password: 'mp' },
    ]);
    expect(spec?.target).toEqual({ host: 'db.internal', port: 5432 });
  });
});

describe('tunnelKeyOf', () => {
  it('changes with the target and the SSH settings, not with the name', () => {
    const key = tunnelKeyOf('c1', base);
    expect(tunnelKeyOf('c1', { ...base, name: 'Renamed' })).toBe(key);
    expect(tunnelKeyOf('c2', base)).not.toBe(key);
    expect(tunnelKeyOf('c1', { ...base, port: 6543 })).not.toBe(key);
    expect(
      tunnelKeyOf('c1', {
        ...base,
        ssh: {
          id: 'main',
          host: 'bastion',
          port: 2222,
          user: 'deploy',
          auth: 'password',
          jumps: [{ id: 'j', host: 'edge', user: 'u', auth: 'agent' }],
        },
      }),
    ).not.toBe(key);
    expect(
      tunnelKeyOf('c1', {
        ...base,
        ssh: { id: 'main', host: 'bastion', port: 2222, user: 'other', auth: 'password' },
      }),
    ).not.toBe(key);
  });
});

function spec(): TunnelSpec {
  return { hops: [], target: { host: 'db', port: 1 }, checkHostKey: check, timeoutMs: 1 };
}

function fakeModule(): SshModule & { opened: FakeTunnel[]; failNext?: Error } {
  const module = {
    opened: [] as FakeTunnel[],
    failNext: undefined as Error | undefined,
    openTunnel: (value: TunnelSpec) => {
      if (module.failNext !== undefined) {
        const error = module.failNext;
        module.failNext = undefined;
        return Promise.reject(error);
      }
      const tunnel = new FakeTunnel(50_000 + module.opened.length, value);
      module.opened.push(tunnel);
      return Promise.resolve(tunnel);
    },
  };
  return module;
}

describe('TunnelPool', () => {
  const logger = new RecordingLogger();

  it('shares one tunnel per key and closes it with the last lease', async () => {
    const module = fakeModule();
    const pool = new TunnelPool({ load: () => Promise.resolve(module), logger });
    const [a, b] = await Promise.all([pool.acquire('k', spec()), pool.acquire('k', spec())]);
    expect(module.opened).toHaveLength(1);
    expect(a.port).toBe(b.port);
    await a.release();
    await a.release();
    expect(module.opened[0]?.closeCount).toBe(0);
    await b.release();
    expect(module.opened[0]?.closeCount).toBe(1);
    expect(pool.size).toBe(0);
  });

  it('opens separate tunnels for separate keys', async () => {
    const module = fakeModule();
    const pool = new TunnelPool({ load: () => Promise.resolve(module), logger });
    const a = await pool.acquire('a', spec());
    const b = await pool.acquire('b', spec());
    expect(a.port).not.toBe(b.port);
    expect(pool.size).toBe(2);
  });

  it('forgets a tunnel that dropped, so the next lease opens a new one', async () => {
    const module = fakeModule();
    const pool = new TunnelPool({ load: () => Promise.resolve(module), logger });
    const first = await pool.acquire('k', spec());
    await module.opened[0]?.close();
    await vi.waitFor(() => {
      expect(pool.size).toBe(0);
    });
    const second = await pool.acquire('k', spec());
    expect(second.port).not.toBe(first.port);
    expect(module.opened).toHaveLength(2);
    // The old lease lets go without touching the new tunnel.
    await first.release();
    expect(module.opened[1]?.closeCount).toBe(0);
  });

  it('reports a failed open to every waiter and tries again next time', async () => {
    const module = fakeModule();
    module.failNext = new DbError('auth-failed', 'nope');
    const pool = new TunnelPool({ load: () => Promise.resolve(module), logger });
    await expect(pool.acquire('k', spec())).rejects.toMatchObject({ code: 'auth-failed' });
    await vi.waitFor(() => {
      expect(pool.size).toBe(0);
    });
    const lease = await pool.acquire('k', spec());
    expect(lease.port).toBe(50_000);
  });

  it('passes the forward error of the tunnel through the lease', async () => {
    const module = fakeModule();
    const pool = new TunnelPool({ load: () => Promise.resolve(module), logger });
    const lease = await pool.acquire('k', spec());
    expect(lease.forwardError()).toBeUndefined();
    const failure = new DbError('connection-failed', 'cannot reach');
    if (module.opened[0]) {
      module.opened[0].failure = failure;
    }
    expect(lease.forwardError()).toBe(failure);
  });

  it('loads the module once and retries a failed load', async () => {
    const module = fakeModule();
    const load = vi
      .fn<() => Promise<SshModule>>()
      .mockRejectedValueOnce(new Error('bundle missing'))
      .mockResolvedValue(module);
    const pool = new TunnelPool({ load, logger });
    await expect(pool.acquire('k', spec())).rejects.toMatchObject({ code: 'internal' });
    await pool.acquire('a', spec());
    await pool.acquire('b', spec());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('opens private tunnels that are never shared', async () => {
    const module = fakeModule();
    const pool = new TunnelPool({ load: () => Promise.resolve(module), logger });
    const a = await pool.openPrivate(spec());
    const b = await pool.openPrivate(spec());
    expect(a).not.toBe(b);
    expect(pool.size).toBe(0);
  });

  it('closes everything on dispose and refuses new leases', async () => {
    const module = fakeModule();
    const pool = new TunnelPool({ load: () => Promise.resolve(module), logger });
    await pool.acquire('a', spec());
    pool.dispose();
    await vi.waitFor(() => {
      expect(module.opened[0]?.closeCount).toBe(1);
    });
    await expect(pool.acquire('b', spec())).rejects.toMatchObject({ code: 'internal' });
  });
});

describe('tunnels through a proxy (V10.2.5)', () => {
  const direct: ConnectionInput = { ...base, ssh: undefined };
  const proxied: ConnectionInput = {
    ...direct,
    proxy: { kind: 'socks5', host: 'proxy.corp', user: 'me' },
  };

  it('makes a spec for a proxy alone, with the default port and the password', () => {
    expect(tunnelSpecOf(proxied, {}, check, 'secret')).toEqual({
      proxy: { kind: 'socks5', host: 'proxy.corp', port: 1080, user: 'me', password: 'secret' },
      hops: [],
      target: { host: 'db.internal', port: 5432 },
      checkHostKey: check,
      timeoutMs: SSH_TIMEOUT_MS,
    });
    expect(
      tunnelSpecOf({ ...direct, proxy: { kind: 'http', host: 'p', port: 3128 } }, {}, check)?.proxy,
    ).toEqual({ kind: 'http', host: 'p', port: 3128 });
  });

  it('puts the proxy in front of the SSH servers when both are set', () => {
    const spec = tunnelSpecOf({ ...proxied, ssh: base.ssh }, {}, check, '');
    expect(spec?.hops).toHaveLength(1);
    expect(spec?.proxy).toEqual({ kind: 'socks5', host: 'proxy.corp', port: 1080, user: 'me' });
  });

  it('changes the key of the shared tunnel with the proxy', () => {
    expect(tunnelKeyOf('c1', proxied)).not.toBe(tunnelKeyOf('c1', direct));
    expect(
      tunnelKeyOf('c1', { ...proxied, proxy: { kind: 'socks5', host: 'other.corp' } }),
    ).not.toBe(tunnelKeyOf('c1', proxied));
  });

  it('opens a proxy alone without loading the SSH module, and the port leads on', async () => {
    const echo = await startEchoServer();
    const proxy = await startSocksProxy();
    const load = vi.fn(() => Promise.reject(new Error('the SSH module is not needed')));
    const pool = new TunnelPool({ load, logger: new RecordingLogger() });
    try {
      const lease = await pool.acquire('k', {
        proxy: { kind: 'socks5', host: '127.0.0.1', port: proxy.port },
        hops: [],
        target: { host: '127.0.0.1', port: echo.port },
        checkHostKey: check,
        timeoutMs: 5000,
      });
      const socket = connect({ host: '127.0.0.1', port: lease.port });
      const reply = await new Promise<string>((resolve) => {
        socket.on('data', (chunk: Buffer) => {
          resolve(chunk.toString());
        });
        socket.write('through');
      });
      socket.destroy();
      expect(reply).toBe('through');
      expect(load).not.toHaveBeenCalled();
      await lease.release();
      expect(pool.size).toBe(0);
    } finally {
      pool.dispose();
      await proxy.close();
      await echo.close();
    }
  });
});
