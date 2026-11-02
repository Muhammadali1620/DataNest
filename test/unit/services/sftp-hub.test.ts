import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { RemoteFileSpec } from '../../../src/services/remote-snapshots';
import { ServerStore } from '../../../src/services/server-store';
import { SftpHub } from '../../../src/services/sftp-hub';
import type { SftpSession } from '../../../src/services/sftp-types';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

class FakeSession implements SftpSession {
  closes = 0;
  readonly closed: Promise<void>;
  private end!: () => void;

  constructor() {
    this.closed = new Promise<void>((resolve) => {
      this.end = resolve;
    });
  }

  /** The link drops. */
  drop(): void {
    this.end();
  }

  close(): void {
    this.closes += 1;
    this.end();
  }

  home = vi.fn(() => Promise.resolve('/home/u'));
  realpath = vi.fn((path: string) => Promise.resolve(path));
  list = vi.fn(() => Promise.resolve([]));
  stat = vi.fn(() => Promise.resolve(undefined));
  openRead = vi.fn(() => Promise.reject(new Error('unused')));
  openWrite = vi.fn(() => Promise.reject(new Error('unused')));
  mkdir = vi.fn(() => Promise.resolve());
  rmdir = vi.fn(() => Promise.resolve());
  unlink = vi.fn(() => Promise.resolve());
  rename = vi.fn(() => Promise.resolve());
  chmod = vi.fn(() => Promise.resolve());
  chown = vi.fn(() => Promise.resolve());
}

/** Lets the promise callbacks that close sessions run. */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const lost = (): DbError => new DbError('connection-failed', 'The connection was lost');

describe('SftpHub', () => {
  let store: ServerStore;
  let sessions: FakeSession[];
  let specs: RemoteFileSpec[];
  let failOpen: Error | undefined;
  let hub: SftpHub;
  let id: string;

  beforeEach(async () => {
    store = new ServerStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });
    id = (
      await store.add(
        {
          name: 'Web',
          ssh: { id: 'main', host: 'web', port: 2222, user: 'deploy', auth: 'password' },
          proxy: { kind: 'socks5', host: 'px' },
        },
        { main: { password: 'pw' } },
        'proxy-pw',
      )
    ).id;
    sessions = [];
    specs = [];
    failOpen = undefined;
    hub = new SftpHub({
      store,
      opener: {
        openSftp: (spec) => {
          specs.push(spec);
          if (failOpen !== undefined) {
            return Promise.reject(failOpen);
          }
          const session = new FakeSession();
          sessions.push(session);
          return Promise.resolve(session);
        },
      },
      checkHostKey: () => Promise.resolve(true),
      logger: new RecordingLogger(),
      idleMs: 0,
    });
  });

  afterEach(() => {
    hub.dispose();
    vi.useRealTimers();
  });

  it('opens the session with the secrets of the server joined in', async () => {
    await hub.session(id);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.hops).toEqual([
      { host: 'web', port: 2222, user: 'deploy', auth: 'password', password: 'pw' },
    ]);
    expect(specs[0]?.proxy).toMatchObject({ kind: 'socks5', host: 'px', password: 'proxy-pw' });
  });

  it('shares one session between everything that works with a server', async () => {
    const [a, b] = await Promise.all([hub.session(id), hub.session(id)]);
    expect(a).toBe(b);
    await hub.run(id, () => Promise.resolve());
    expect(sessions).toHaveLength(1);
  });

  it('refuses a server that does not exist', async () => {
    await expect(hub.session('nope')).rejects.toMatchObject({ code: 'not-found' });
    expect(hub.isOpen('nope')).toBe(false);
  });

  it('tells when a session opens and closes', async () => {
    const seen: string[] = [];
    hub.onDidChangeState((server) => seen.push(`${server}:${String(hub.isOpen(server))}`));
    await hub.session(id);
    expect(hub.isOpen(id)).toBe(true);
    hub.disconnect(id);
    await settle();
    expect(hub.isOpen(id)).toBe(false);
    expect(seen).toEqual([`${id}:true`, `${id}:false`]);
    expect(sessions[0]?.closes).toBe(1);
  });

  it('forgets a session whose link dropped, and opens a new one next time', async () => {
    const first = await hub.session(id);
    sessions[0]?.drop();
    await first.closed;
    await Promise.resolve();
    expect(hub.isOpen(id)).toBe(false);
    const second = await hub.session(id);
    expect(second).not.toBe(first);
  });

  it('does not keep a session that failed to open: the next try starts again', async () => {
    failOpen = new DbError('auth-failed', 'wrong password');
    await expect(hub.session(id)).rejects.toMatchObject({ code: 'auth-failed' });
    expect(hub.isOpen(id)).toBe(false);
    failOpen = undefined;
    await expect(hub.session(id)).resolves.toBeDefined();
    expect(specs).toHaveLength(2);
  });

  it('does not repeat a first connect that failed', async () => {
    failOpen = lost();
    await expect(hub.run(id, () => Promise.resolve('x'))).rejects.toMatchObject({
      code: 'connection-failed',
    });
    expect(specs).toHaveLength(1);
  });

  it('opens a new session and tries once more when a working one turned out to be dead', async () => {
    await hub.session(id);
    let tries = 0;
    const result = await hub.run(id, (session) => {
      tries += 1;
      if (tries === 1) {
        return Promise.reject(lost());
      }
      return Promise.resolve(session);
    });
    expect(tries).toBe(2);
    expect(sessions).toHaveLength(2);
    expect(result).toBe(sessions[1]);
    expect(sessions[0]?.closes).toBe(1);
  });

  it('tries only once more', async () => {
    await hub.session(id);
    let tries = 0;
    await expect(
      hub.run(id, () => {
        tries += 1;
        return Promise.reject(lost());
      }),
    ).rejects.toMatchObject({ code: 'connection-failed' });
    expect(tries).toBe(2);
  });

  it('passes other errors on at once', async () => {
    await hub.session(id);
    let tries = 0;
    await expect(
      hub.run(id, () => {
        tries += 1;
        return Promise.reject(new DbError('not-found', 'gone'));
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
    expect(tries).toBe(1);
  });

  it('closes a session nobody used for a while, and opens it again when needed', async () => {
    vi.useFakeTimers();
    const idle = new SftpHub({
      store,
      opener: {
        openSftp: () => {
          const session = new FakeSession();
          sessions.push(session);
          return Promise.resolve(session);
        },
      },
      checkHostKey: () => Promise.resolve(true),
      logger: new RecordingLogger(),
      idleMs: 1000,
    });
    await idle.run(id, () => Promise.resolve());
    expect(idle.isOpen(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(idle.isOpen(id)).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    expect(idle.isOpen(id)).toBe(false);
    expect(sessions[0]?.closes).toBe(1);
    await idle.run(id, () => Promise.resolve());
    expect(sessions).toHaveLength(2);
    idle.dispose();
  });

  it('does not close a session while work runs on it', async () => {
    vi.useFakeTimers();
    const idle = new SftpHub({
      store,
      opener: {
        openSftp: () => {
          const session = new FakeSession();
          sessions.push(session);
          return Promise.resolve(session);
        },
      },
      checkHostKey: () => Promise.resolve(true),
      logger: new RecordingLogger(),
      idleMs: 1000,
    });
    let finish!: () => void;
    const running = idle.run(
      id,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(idle.isOpen(id)).toBe(true);
    finish();
    await running;
    await vi.advanceTimersByTimeAsync(1001);
    expect(idle.isOpen(id)).toBe(false);
    idle.dispose();
  });

  it('closes every session at the end and refuses new work', async () => {
    const other = await store.add({
      name: 'Web 2',
      ssh: { id: 'main', host: 'web2', user: 'u', auth: 'agent' },
    });
    await hub.session(id);
    await hub.session(other.id);
    hub.dispose();
    await settle();
    expect(sessions.map((session) => session.closes)).toEqual([1, 1]);
    await expect(hub.session(id)).rejects.toMatchObject({ code: 'internal' });
  });

  it('disconnecting a server that is not open does nothing', () => {
    expect(() => {
      hub.disconnect(id);
    }).not.toThrow();
  });

  it('does not fail because a state listener does', async () => {
    hub.onDidChangeState(() => {
      throw new Error('boom');
    });
    await expect(hub.session(id)).resolves.toBeDefined();
  });
});
