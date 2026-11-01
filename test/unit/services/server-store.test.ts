import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import {
  SERVERS_STATE_KEY,
  ServerStore,
  serverProxySecretKey,
  serverSecretKey,
} from '../../../src/services/server-store';
import type { SshServerInput } from '../../../src/shared/ssh-server';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

const input: SshServerInput = {
  name: 'Web 1',
  ssh: { id: 'main', host: 'web1.example.com', user: 'deploy', auth: 'password' },
};

describe('ServerStore', () => {
  let state: FakeMemento;
  let secrets: FakeSecretStorage;
  let logger: RecordingLogger;
  let store: ServerStore;

  beforeEach(() => {
    state = new FakeMemento();
    secrets = new FakeSecretStorage();
    logger = new RecordingLogger();
    store = new ServerStore({ state, secrets, logger });
  });

  it('adds a server with its own id and keeps it across a restart', async () => {
    const first = await store.add(input);
    const second = await store.add({ ...input, name: 'Web 2' });
    expect(first.id).not.toBe(second.id);
    const reloaded = new ServerStore({ state, secrets, logger });
    expect(reloaded.list().map((item) => item.name)).toEqual(['Web 1', 'Web 2']);
    expect(reloaded.get(first.id)).toEqual(first);
  });

  it('trims and drops what means nothing', async () => {
    const config = await store.add({
      name: '  Web  ',
      startPath: '   ',
      readOnly: false,
      ssh: { id: 'main', host: ' h ', user: ' u ', auth: 'agent', keyFile: '/ignored' },
    });
    expect(config).toEqual({
      id: config.id,
      name: 'Web',
      ssh: { id: 'main', host: 'h', user: 'u', auth: 'agent' },
    });
  });

  it('keeps the start folder, the flag, the color and jump hosts', async () => {
    const config = await store.add({
      ...input,
      startPath: '/var/www',
      readOnly: true,
      color: 'red',
      ssh: {
        ...input.ssh,
        jumps: [{ id: 'jump', host: 'bastion', user: 'me', auth: 'agent' }],
      },
    });
    expect(config).toMatchObject({ startPath: '/var/www', readOnly: true, color: 'red' });
    expect(config.ssh.jumps).toHaveLength(1);
  });

  it('refuses a server that cannot be saved, saying why', async () => {
    await expect(store.add({ ...input, name: '  ' })).rejects.toThrow(/name is empty/u);
    await expect(
      store.add({ ...input, ssh: { ...input.ssh, host: '', user: '' } }),
    ).rejects.toThrow(/host is empty.*user is empty/u);
    await expect(store.add({ ...input, ssh: { ...input.ssh, auth: 'key' } })).rejects.toThrow(
      /key file/u,
    );
    await expect(
      store.add({ ...input, ssh: { ...input.ssh, port: 70_000 } }),
    ).rejects.toBeInstanceOf(DbError);
    expect(store.list()).toEqual([]);
  });

  it('keeps passwords only in secrets, never in the saved state', async () => {
    const config = await store.add(input, { main: { password: 'hunter2', passphrase: 'p' } });
    expect(await store.getSshSecrets(config.id)).toEqual({
      main: { password: 'hunter2', passphrase: 'p' },
    });
    expect(JSON.stringify([...state.data.entries()])).not.toContain('hunter2');
    expect(JSON.stringify(store.list())).not.toContain('hunter2');
  });

  it('keeps the proxy and its password apart', async () => {
    const config = await store.add(
      { ...input, proxy: { kind: 'socks5', host: 'proxy', user: 'px' } },
      {},
      'proxy-pw',
    );
    expect(await store.getProxyPassword(config.id)).toBe('proxy-pw');
    expect(JSON.stringify([...state.data.entries()])).not.toContain('proxy-pw');
  });

  it('stores no secret for an empty password', async () => {
    const config = await store.add(input, { main: { password: '' } }, '');
    expect(await store.getSshSecrets(config.id)).toEqual({ main: {} });
    expect(await store.getProxyPassword(config.id)).toBeUndefined();
  });

  it('updates a server and keeps, sets or clears its secrets', async () => {
    const config = await store.add(input, { main: { password: 'one', passphrase: 'pp' } });
    await store.update(config.id, { ...input, name: 'Renamed' });
    expect(store.get(config.id)?.name).toBe('Renamed');
    expect((await store.getSshSecrets(config.id)).main).toEqual({
      password: 'one',
      passphrase: 'pp',
    });
    await store.update(config.id, input, {
      main: { password: { kind: 'set', value: 'two' }, passphrase: { kind: 'clear' } },
    });
    expect((await store.getSshSecrets(config.id)).main).toEqual({ password: 'two' });
  });

  it('takes the secrets of a jump host away with the host', async () => {
    const withJump: SshServerInput = {
      ...input,
      ssh: { ...input.ssh, jumps: [{ id: 'jump', host: 'b', user: 'u', auth: 'password' }] },
    };
    const config = await store.add(withJump, { jump: { password: 'jp' } });
    expect(await secrets.get(serverSecretKey(config.id, 'jump', 'password'))).toBe('jp');
    await store.update(config.id, input);
    expect(await secrets.get(serverSecretKey(config.id, 'jump', 'password'))).toBeUndefined();
  });

  it('drops the proxy password when the proxy goes', async () => {
    const config = await store.add({ ...input, proxy: { kind: 'http', host: 'p' } }, {}, 'secret');
    await store.update(config.id, input);
    expect(await secrets.get(serverProxySecretKey(config.id))).toBeUndefined();
  });

  it('refuses to update a server that does not exist', async () => {
    await expect(store.update('nope', input)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('removes a server and every one of its secrets; removing it again is a no-op', async () => {
    const config = await store.add(
      { ...input, proxy: { kind: 'socks5', host: 'p' } },
      { main: { password: 'pw', passphrase: 'pp' } },
      'px',
    );
    await store.remove(config.id);
    expect(store.list()).toEqual([]);
    expect(await secrets.get(serverSecretKey(config.id, 'main', 'password'))).toBeUndefined();
    expect(await secrets.get(serverSecretKey(config.id, 'main', 'passphrase'))).toBeUndefined();
    expect(await secrets.get(serverProxySecretKey(config.id))).toBeUndefined();
    await expect(store.remove(config.id)).resolves.toBeUndefined();
  });

  it('puts a server in and out of read-only mode', async () => {
    const config = await store.add(input);
    await store.setReadOnly(config.id, true);
    expect(store.get(config.id)?.readOnly).toBe(true);
    await store.setReadOnly(config.id, false);
    expect(store.get(config.id)).toEqual(config);
    await expect(store.setReadOnly('nope', true)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('tells the listeners about every change, and a listener that fails changes nothing', async () => {
    let calls = 0;
    store.onDidChange(() => {
      calls += 1;
    });
    store.onDidChange(() => {
      throw new Error('boom');
    });
    const config = await store.add(input);
    await store.update(config.id, input);
    await store.setReadOnly(config.id, true);
    await store.remove(config.id);
    expect(calls).toBe(4);
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
  });

  it('stops telling a listener that was disposed', async () => {
    let calls = 0;
    const subscription = store.onDidChange(() => {
      calls += 1;
    });
    subscription.dispose();
    await store.add(input);
    expect(calls).toBe(0);
  });

  it('starts empty and says so when the saved state is broken', () => {
    state.data.set(SERVERS_STATE_KEY, { version: 1, items: [{ id: 5 }] });
    const broken = new ServerStore({ state, secrets, logger });
    expect(broken.list()).toEqual([]);
    expect(logger.entries.some((entry) => entry.level === 'error')).toBe(true);
  });

  it('returns no secrets for a server that does not exist', async () => {
    expect(await store.getSshSecrets('nope')).toEqual({});
  });
});
