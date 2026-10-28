import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ConnectionInput } from '../../../src/shared/connection';
import {
  CONNECTIONS_STATE_KEY,
  ConnectionStore,
  passwordSecretKey,
  sshSecretKey,
} from '../../../src/services/connection-store';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

const mysqlInput: ConnectionInput = {
  name: 'Local MySQL',
  driver: 'mysql',
  host: '127.0.0.1',
  port: 7306,
  user: 'root',
  database: 'app',
};

describe('ConnectionStore', () => {
  let state: FakeMemento;
  let secrets: FakeSecretStorage;
  let logger: RecordingLogger;
  let store: ConnectionStore;

  beforeEach(() => {
    state = new FakeMemento();
    secrets = new FakeSecretStorage();
    logger = new RecordingLogger();
    store = new ConnectionStore({ state, secrets, logger });
  });

  describe('add', () => {
    it('adds a connection with a unique id and persists it', async () => {
      const first = await store.add(mysqlInput, 'secret');
      const second = await store.add({ name: 'Other', driver: 'sqlite', file: '/db' });
      expect(first.id).not.toBe(second.id);
      expect(store.list().map((c) => c.name)).toEqual(['Local MySQL', 'Other']);
      const reloaded = new ConnectionStore({ state, secrets, logger });
      expect(reloaded.list()).toEqual(store.list());
    });

    it('stores the password only in secrets, never in state', async () => {
      const config = await store.add(mysqlInput, 'hunter2');
      expect(await store.getPassword(config.id)).toBe('hunter2');
      expect(JSON.stringify([...state.data.entries()])).not.toContain('hunter2');
      expect(JSON.stringify(store.list())).not.toContain('hunter2');
    });

    it('does not create a secret for an empty or missing password', async () => {
      const a = await store.add(mysqlInput);
      const b = await store.add({ ...mysqlInput, name: 'b' }, '');
      expect(secrets.data.size).toBe(0);
      expect(await store.getPassword(a.id)).toBeUndefined();
      expect(await store.getPassword(b.id)).toBeUndefined();
    });

    it('trims text fields and drops empty optional ones', async () => {
      const config = await store.add({
        name: '  Padded  ',
        driver: 'mysql',
        host: ' h ',
        user: '  ',
        database: '',
      });
      expect(config).toMatchObject({ name: 'Padded', host: 'h' });
      expect(config.user).toBeUndefined();
      expect(config.database).toBeUndefined();
    });

    it('drops fields that do not apply to the driver kind', async () => {
      const config = await store.add({
        name: 'File',
        driver: 'sqlite',
        file: '/db',
        host: 'ignored',
        port: 7306,
        user: 'ignored',
      });
      expect(config.host).toBeUndefined();
      expect(config.port).toBeUndefined();
      expect(config.user).toBeUndefined();
      expect(config.file).toBe('/db');
    });

    it('rejects invalid input', async () => {
      await expect(store.add({ name: '', driver: 'mysql', host: 'h' })).rejects.toThrow(
        'name-empty',
      );
      await expect(store.add({ name: 'x', driver: 'sqlite' })).rejects.toThrow('file-empty');
      expect(store.list()).toEqual([]);
    });
  });

  describe('update', () => {
    it('replaces the config and keeps the order', async () => {
      const a = await store.add(mysqlInput);
      await store.add({ name: 'B', driver: 'sqlite', file: '/b' });
      await store.update(a.id, { ...mysqlInput, name: 'Renamed' });
      expect(store.list().map((c) => c.name)).toEqual(['Renamed', 'B']);
    });

    it('keeps the password by default', async () => {
      const a = await store.add(mysqlInput, 'old');
      await store.update(a.id, mysqlInput);
      expect(await store.getPassword(a.id)).toBe('old');
    });

    it('replaces the password with kind=set', async () => {
      const a = await store.add(mysqlInput, 'old');
      await store.update(a.id, mysqlInput, { kind: 'set', value: 'new' });
      expect(await store.getPassword(a.id)).toBe('new');
    });

    it('erases the password with kind=clear or an empty set', async () => {
      const a = await store.add(mysqlInput, 'old');
      await store.update(a.id, mysqlInput, { kind: 'clear' });
      expect(await store.getPassword(a.id)).toBeUndefined();
      await store.update(a.id, mysqlInput, { kind: 'set', value: 'x' });
      await store.update(a.id, mysqlInput, { kind: 'set', value: '' });
      expect(await store.getPassword(a.id)).toBeUndefined();
    });

    it('throws not-found for an unknown id', async () => {
      await expect(store.update('missing', mysqlInput)).rejects.toMatchObject({
        name: 'DbError',
        code: 'not-found',
      });
    });
  });

  describe('remove', () => {
    it('removes the config together with its password', async () => {
      const a = await store.add(mysqlInput, 'secret');
      await store.remove(a.id);
      expect(store.list()).toEqual([]);
      expect(secrets.data.has(passwordSecretKey(a.id))).toBe(false);
    });

    it('is a silent no-op for an unknown id', async () => {
      await store.add(mysqlInput);
      await expect(store.remove('missing')).resolves.toBeUndefined();
      expect(store.list()).toHaveLength(1);
    });
  });

  describe('duplicate', () => {
    it('copies the config and its password under a new id', async () => {
      const a = await store.add(mysqlInput, 'secret');
      const copy = await store.duplicate(a.id);
      expect(copy.id).not.toBe(a.id);
      expect(copy.name).toBe('Local MySQL (copy)');
      expect(copy.host).toBe(a.host);
      expect(await store.getPassword(copy.id)).toBe('secret');
    });

    it('numbers copies when the name is taken and accepts an explicit name', async () => {
      const a = await store.add(mysqlInput);
      const first = await store.duplicate(a.id);
      const second = await store.duplicate(a.id);
      expect(first.name).toBe('Local MySQL (copy)');
      expect(second.name).toBe('Local MySQL (copy 2)');
      const named = await store.duplicate(a.id, 'Staging');
      expect(named.name).toBe('Staging');
    });

    it('does not invent a password when the source has none', async () => {
      const a = await store.add(mysqlInput);
      const copy = await store.duplicate(a.id);
      expect(await store.getPassword(copy.id)).toBeUndefined();
      expect(secrets.data.size).toBe(0);
    });

    it('throws not-found for an unknown id', async () => {
      await expect(store.duplicate('missing')).rejects.toMatchObject({ code: 'not-found' });
    });
  });

  describe('onDidChange', () => {
    it('fires once per mutation and not for reads', async () => {
      let fired = 0;
      store.onDidChange(() => fired++);
      const a = await store.add(mysqlInput);
      await store.update(a.id, mysqlInput);
      await store.duplicate(a.id);
      store.list();
      await store.getPassword(a.id);
      await store.remove(a.id);
      expect(fired).toBe(4);
    });

    it('does not fire after the listener is disposed or for no-op removes', async () => {
      let fired = 0;
      const subscription = store.onDidChange(() => fired++);
      await store.remove('missing');
      subscription.dispose();
      await store.add(mysqlInput);
      expect(fired).toBe(0);
    });

    it('a throwing listener is logged and does not break others', async () => {
      let fired = 0;
      store.onDidChange(() => {
        throw new Error('boom');
      });
      store.onDidChange(() => fired++);
      await store.add(mysqlInput);
      expect(fired).toBe(1);
      expect(logger.messages('warn')).toContain('A connection change listener failed');
    });
  });

  describe('corrupted state', () => {
    it('starts empty and logs when the stored value has a wrong shape', () => {
      const badState = new FakeMemento(new Map([[CONNECTIONS_STATE_KEY, { version: 99 }]]));
      const log = new RecordingLogger();
      const broken = new ConnectionStore({ state: badState, secrets, logger: log });
      expect(broken.list()).toEqual([]);
      expect(log.messages('error')).toContain('Saved connections are corrupted and were ignored');
    });

    it('rejects a config entry with an injected unknown field', () => {
      const badState = new FakeMemento(
        new Map([
          [
            CONNECTIONS_STATE_KEY,
            {
              version: 1,
              items: [{ id: 'a', name: 'ok', driver: 'mysql', host: 'h', __proto__injected: true }],
            },
          ],
        ]),
      );
      const broken = new ConnectionStore({ state: badState, secrets, logger });
      expect(broken.list()).toEqual([]);
    });

    it('errors from the store surface as DbError, not silent corruption', async () => {
      await expect(store.update('missing', mysqlInput)).rejects.toBeInstanceOf(DbError);
    });
  });

  describe('SSH', () => {
    const viaSsh: ConnectionInput = {
      ...mysqlInput,
      ssh: { id: 'main', host: ' bastion ', port: 2222, user: ' deploy ', auth: 'password' },
    };

    it('saves the hop trimmed and its secrets in SecretStorage only', async () => {
      const config = await store.add(viaSsh, 'db', { main: { password: 'sshpw', passphrase: '' } });
      expect(config.ssh).toEqual({
        id: 'main',
        host: 'bastion',
        port: 2222,
        user: 'deploy',
        auth: 'password',
      });
      expect(secrets.data.get(sshSecretKey(config.id, 'main', 'password'))).toBe('sshpw');
      expect(secrets.data.has(sshSecretKey(config.id, 'main', 'passphrase'))).toBe(false);
      expect(JSON.stringify(state.get(CONNECTIONS_STATE_KEY))).not.toContain('sshpw');
      expect(await store.getSshSecrets(config.id)).toEqual({ main: { password: 'sshpw' } });
    });

    it('keeps only the fields of the chosen method', async () => {
      const config = await store.add({
        ...mysqlInput,
        ssh: {
          id: 'main',
          host: 'b',
          user: 'u',
          auth: 'agent',
          keyFile: '/key',
          agentSocket: ' /run/agent ',
        },
      });
      expect(config.ssh).toEqual({
        id: 'main',
        host: 'b',
        user: 'u',
        auth: 'agent',
        agentSocket: '/run/agent',
      });
    });

    it('drops SSH settings for file databases', async () => {
      const config = await store.add({ name: 'f', driver: 'sqlite', file: '/db', ssh: viaSsh.ssh });
      expect(config.ssh).toBeUndefined();
    });

    it('refuses a hop that cannot be used', async () => {
      await expect(
        store.add({ ...mysqlInput, ssh: { id: 'main', host: '', user: 'u', auth: 'password' } }),
      ).rejects.toMatchObject({ message: expect.stringContaining('ssh-host-empty') as unknown });
      await expect(
        store.add({ ...mysqlInput, ssh: { id: 'a b', host: 'h', user: 'u', auth: 'password' } }),
      ).rejects.toMatchObject({ message: expect.stringContaining('ssh-id-invalid') as unknown });
    });

    it('keeps, replaces and erases hop secrets on update', async () => {
      const config = await store.add(viaSsh, undefined, { main: { password: 'one' } });
      await store.update(config.id, viaSsh);
      expect(await store.getSshSecrets(config.id)).toEqual({ main: { password: 'one' } });
      await store.update(config.id, viaSsh, undefined, {
        main: { password: { kind: 'set', value: 'two' }, passphrase: { kind: 'set', value: 'pp' } },
      });
      expect(await store.getSshSecrets(config.id)).toEqual({
        main: { password: 'two', passphrase: 'pp' },
      });
      await store.update(config.id, viaSsh, undefined, {
        main: { password: { kind: 'clear' }, passphrase: { kind: 'set', value: '' } },
      });
      expect(await store.getSshSecrets(config.id)).toEqual({ main: {} });
    });

    it('erases the secrets of a hop that was removed or replaced', async () => {
      const config = await store.add(viaSsh, 'db', { main: { password: 'p', passphrase: 'q' } });
      await store.update(config.id, {
        ...viaSsh,
        ssh: { id: 'other', host: 'bastion', user: 'deploy', auth: 'password' },
      });
      expect(secrets.data.has(sshSecretKey(config.id, 'main', 'password'))).toBe(false);
      expect(secrets.data.has(sshSecretKey(config.id, 'main', 'passphrase'))).toBe(false);
      await store.update(config.id, mysqlInput);
      expect(store.get(config.id)?.ssh).toBeUndefined();
      expect(await store.getPassword(config.id)).toBe('db');
    });

    it('removes and duplicates hop secrets along with the connection', async () => {
      const config = await store.add(viaSsh, undefined, { main: { password: 'p' } });
      const copy = await store.duplicate(config.id);
      expect(copy.ssh).toEqual(config.ssh);
      expect(await store.getSshSecrets(copy.id)).toEqual({ main: { password: 'p' } });
      await store.remove(config.id);
      expect(secrets.data.has(sshSecretKey(config.id, 'main', 'password'))).toBe(false);
      expect(await store.getSshSecrets(copy.id)).toEqual({ main: { password: 'p' } });
    });

    it('has no SSH secrets for unknown or direct connections', async () => {
      expect(await store.getSshSecrets('missing')).toEqual({});
      const direct = await store.add(mysqlInput);
      expect(await store.getSshSecrets(direct.id)).toEqual({});
    });

    it('loads saved state with an SSH hop and rejects a broken one', () => {
      const good = new FakeMemento(
        new Map<string, unknown>([
          [
            CONNECTIONS_STATE_KEY,
            {
              version: 1,
              items: [{ id: 'x', name: 'n', driver: 'mysql', host: 'h', ssh: viaSsh.ssh }],
            },
          ],
        ]),
      );
      expect(new ConnectionStore({ state: good, secrets, logger }).get('x')?.ssh?.id).toBe('main');
      const bad = new FakeMemento(
        new Map<string, unknown>([
          [
            CONNECTIONS_STATE_KEY,
            {
              version: 1,
              items: [{ id: 'x', name: 'n', driver: 'mysql', host: 'h', ssh: { id: 'main' } }],
            },
          ],
        ]),
      );
      expect(new ConnectionStore({ state: bad, secrets, logger }).list()).toEqual([]);
    });

    it('stores jumps normalized, with secrets per jump, and erases those of a removed jump', async () => {
      const main = { id: 'main', host: 'bastion', user: 'deploy', auth: 'password' as const };
      const jumpB = { id: 'b', host: 'b.example', user: 'j', auth: 'key' as const, keyFile: '/k' };
      const jumps = [
        { id: 'a', host: ' a.example ', user: 'j', auth: 'password' as const, keyFile: '/x' },
        jumpB,
      ];
      const config = await store.add({ ...viaSsh, ssh: { ...main, jumps } }, undefined, {
        a: { password: 'pa' },
        b: { passphrase: 'pb' },
        main: { password: 'pm' },
      });
      expect(config.ssh?.jumps).toEqual([
        { id: 'a', host: 'a.example', user: 'j', auth: 'password' },
        { id: 'b', host: 'b.example', user: 'j', auth: 'key', keyFile: '/k' },
      ]);
      expect(await store.getSshSecrets(config.id)).toEqual({
        a: { password: 'pa' },
        b: { passphrase: 'pb' },
        main: { password: 'pm' },
      });
      await store.update(config.id, { ...viaSsh, ssh: { ...main, jumps: [jumpB] } });
      expect(secrets.data.has(sshSecretKey(config.id, 'a', 'password'))).toBe(false);
      expect(await store.getSshSecrets(config.id)).toEqual({
        b: { passphrase: 'pb' },
        main: { password: 'pm' },
      });
    });

    it('drops an empty jump list', async () => {
      const config = await store.add({
        ...viaSsh,
        ssh: { id: 'main', host: 'bastion', user: 'deploy', auth: 'password', jumps: [] },
      });
      expect(config.ssh).not.toHaveProperty('jumps');
    });
  });
});

describe('ConnectionStore SSL', () => {
  it('keeps the mode and trimmed files, and drops SSL for file databases', async () => {
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });
    const config = await store.add({
      ...mysqlInput,
      ssl: { mode: 'verify-ca', ca: ' /etc/ca.crt ', cert: '', key: ' ' },
    });
    expect(config.ssl).toEqual({ mode: 'verify-ca', ca: '/etc/ca.crt' });
    const file = await store.add({
      name: 'f',
      driver: 'sqlite',
      file: '/db',
      ssl: { mode: 'require' },
    });
    expect(file.ssl).toBeUndefined();
    await expect(
      store.add({ ...mysqlInput, ssl: { mode: 'require', cert: '/c' } }),
    ).rejects.toThrow('ssl-cert-without-key');
  });
});
