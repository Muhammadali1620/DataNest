import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ConnectionInput } from '../../../src/shared/connection';
import {
  CONNECTIONS_STATE_KEY,
  ConnectionStore,
  passwordSecretKey,
  sentinelSecretKey,
  sshSecretKey,
} from '../../../src/services/connection-store';
import {
  type ProjectFiles,
  type ProjectFolder,
  ProjectConnections,
  projectConnectionId,
} from '../../../src/services/project-connections';
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

describe('ConnectionStore folders', () => {
  let state: FakeMemento;
  let store: ConnectionStore;
  const input = (name: string, folder?: string): ConnectionInput => ({
    name,
    driver: 'mysql',
    host: 'h',
    ...(folder === undefined ? {} : { folder }),
  });
  const order = () => store.list().map((config) => `${config.folder ?? '-'}:${config.name}`);

  beforeEach(() => {
    state = new FakeMemento();
    store = new ConnectionStore({
      state,
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });
  });

  it('creates folders in order and refuses empty, too long or taken names', async () => {
    await store.createFolder(' Prod ');
    await store.createFolder('Dev');
    expect(store.folders()).toEqual(['Prod', 'Dev']);
    await expect(store.createFolder('Prod')).rejects.toThrow('already exists');
    await expect(store.createFolder('  ')).rejects.toThrow('name');
    await expect(store.createFolder('x'.repeat(201))).rejects.toThrow('name');
  });

  it('saves folders and connections as version 2 and reads them back', async () => {
    await store.createFolder('Prod');
    await store.add(input('a', 'Prod'));
    expect(state.get(CONNECTIONS_STATE_KEY)).toMatchObject({ version: 2, folders: ['Prod'] });
    const reloaded = new ConnectionStore({
      state,
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });
    expect(reloaded.folders()).toEqual(['Prod']);
    expect(reloaded.list()[0]?.folder).toBe('Prod');
  });

  it('reads version 1 state without folders', () => {
    const old = new FakeMemento(
      new Map<string, unknown>([
        [
          CONNECTIONS_STATE_KEY,
          { version: 1, items: [{ id: 'x', name: 'n', driver: 'mysql', host: 'h' }] },
        ],
      ]),
    );
    const loaded = new ConnectionStore({
      state: old,
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });
    expect(loaded.folders()).toEqual([]);
    expect(loaded.list()).toHaveLength(1);
  });

  it('lists a folder a connection names even when the list lost it', async () => {
    await store.add(input('a', 'Imported'));
    expect(store.folders()).toEqual(['Imported']);
    const broken = new FakeMemento(
      new Map<string, unknown>([
        [
          CONNECTIONS_STATE_KEY,
          {
            version: 2,
            folders: ['A', 'A'],
            items: [{ id: 'x', name: 'n', driver: 'mysql', host: 'h', folder: 'B' }],
          },
        ],
      ]),
    );
    expect(
      new ConnectionStore({
        state: broken,
        secrets: new FakeSecretStorage(),
        logger: new RecordingLogger(),
      }).folders(),
    ).toEqual(['A', 'B']);
  });

  it('renames a folder with its connections, and refuses a taken name', async () => {
    await store.createFolder('Prod');
    await store.createFolder('Dev');
    await store.add(input('a', 'Prod'));
    expect(await store.renameFolder('Prod', ' Live ')).toBe('Live');
    expect(store.folders()).toEqual(['Live', 'Dev']);
    expect(store.list()[0]?.folder).toBe('Live');
    await expect(store.renameFolder('Live', 'Dev')).rejects.toThrow('already exists');
    await expect(store.renameFolder('Missing', 'X')).rejects.toMatchObject({ code: 'not-found' });
    expect(await store.renameFolder('Dev', 'Dev')).toBe('Dev');
  });

  it('removes a folder and moves its connections to the top level', async () => {
    await store.createFolder('Prod');
    const a = await store.add(input('a', 'Prod'));
    await store.removeFolder('Prod');
    expect(store.folders()).toEqual([]);
    expect(store.get(a.id)).not.toHaveProperty('folder');
    await expect(store.removeFolder('Prod')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('moves a folder in front of another one, or last', async () => {
    for (const name of ['A', 'B', 'C']) {
      await store.createFolder(name);
    }
    await store.moveFolder('C', 'A');
    expect(store.folders()).toEqual(['C', 'A', 'B']);
    await store.moveFolder('C');
    expect(store.folders()).toEqual(['A', 'B', 'C']);
    await store.moveFolder('A', 'missing');
    expect(store.folders()).toEqual(['B', 'C', 'A']);
    await store.moveFolder('B', 'B');
    expect(store.folders()).toEqual(['B', 'C', 'A']);
  });

  it('moves connections into a folder, keeping their order, after its last one', async () => {
    await store.createFolder('Prod');
    const a = await store.add(input('a'));
    const b = await store.add(input('b', 'Prod'));
    const c = await store.add(input('c'));
    await store.add(input('d'));
    await store.moveConnections([c.id, a.id], { folder: 'Prod' });
    expect(order()).toEqual(['Prod:b', 'Prod:a', 'Prod:c', '-:d']);
    await store.moveConnections([b.id], { folder: 'Prod', before: a.id });
    expect(order()).toEqual(['Prod:b', 'Prod:a', 'Prod:c', '-:d']);
    await store.moveConnections([c.id], { folder: 'Prod', before: b.id });
    expect(order()).toEqual(['Prod:c', 'Prod:b', 'Prod:a', '-:d']);
  });

  it('moves connections to the top level, at its end or before one', async () => {
    await store.createFolder('Prod');
    const a = await store.add(input('a', 'Prod'));
    const b = await store.add(input('b'));
    await store.moveConnections([a.id], {});
    expect(order()).toEqual(['-:b', '-:a']);
    expect(store.get(a.id)).not.toHaveProperty('folder');
    await store.moveConnections([a.id], { before: b.id });
    expect(order()).toEqual(['-:a', '-:b']);
  });

  it('refuses a folder that does not exist and ignores unknown ids', async () => {
    const a = await store.add(input('a'));
    await expect(store.moveConnections([a.id], { folder: 'Nope' })).rejects.toMatchObject({
      code: 'not-found',
    });
    let changes = 0;
    store.onDidChange(() => {
      changes += 1;
    });
    await store.moveConnections(['missing'], {});
    expect(changes).toBe(0);
  });

  it('sets and clears a color, and keeps both through edits and copies', async () => {
    const a = await store.add({ ...input('a'), color: 'red' });
    expect(a.color).toBe('red');
    await store.setColor(a.id, 'blue');
    expect(store.get(a.id)?.color).toBe('blue');
    const copy = await store.duplicate(a.id);
    expect(copy.color).toBe('blue');
    await store.setColor(a.id, undefined);
    expect(store.get(a.id)).not.toHaveProperty('color');
    await expect(store.setColor('missing', 'red')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('takes the folder from the form, creating it, trimmed', async () => {
    const a = await store.add(input('a', '  New one '));
    expect(a.folder).toBe('New one');
    expect(store.folders()).toEqual(['New one']);
    const updated = await store.update(a.id, input('a', ''));
    expect(updated.folder).toBeUndefined();
    expect(store.folders()).toEqual(['New one']);
  });
});

describe('ConnectionStore production and read-only', () => {
  it('stores the flags only when they are set', async () => {
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });
    const guarded = await store.add({ ...mysqlInput, production: true, readOnly: true });
    expect(guarded).toMatchObject({ production: true, readOnly: true });
    const plain = await store.add({ ...mysqlInput, production: false, readOnly: false });
    expect(JSON.parse(JSON.stringify(plain))).not.toHaveProperty('production');
    expect(JSON.parse(JSON.stringify(plain))).not.toHaveProperty('readOnly');
  });
});

describe('ConnectionStore project connections', () => {
  const SHOP: ProjectFolder = { key: 'file:///shop', name: 'shop', root: '/shop' };

  class MemoryFiles implements ProjectFiles {
    readonly texts = new Map<string, string>();

    read(folder: ProjectFolder): Promise<string | undefined> {
      return Promise.resolve(this.texts.get(folder.key));
    }

    write(folder: ProjectFolder, text: string): Promise<void> {
      this.texts.set(folder.key, text);
      return Promise.resolve();
    }
  }

  async function setup(text?: string) {
    const files = new MemoryFiles();
    if (text !== undefined) {
      files.texts.set(SHOP.key, text);
    }
    const logger = new RecordingLogger();
    const projects = new ProjectConnections({ files, logger });
    await projects.load([SHOP], true);
    const secrets = new FakeSecretStorage();
    const state = new FakeMemento();
    const store = new ConnectionStore({ state, secrets, logger, projects });
    return { files, projects, secrets, state, store };
  }

  const shared = JSON.stringify({
    connections: [
      {
        id: 'dev',
        name: 'Dev',
        driver: 'postgres',
        host: 'db',
        ssh: { id: 'b', host: 'bastion', user: 'u', auth: 'password' },
      },
    ],
  });
  const devId = projectConnectionId(SHOP.key, 'dev');

  it('lists the user connections first, then the project ones, and finds both', async () => {
    const { store } = await setup(shared);
    const own = await store.add(mysqlInput);
    expect(store.list().map((config) => config.id)).toEqual([own.id, devId]);
    expect(store.get(devId)?.name).toBe('Dev');
    expect(store.projectOf(devId)).toEqual(SHOP);
    expect(store.projectOf(own.id)).toBeUndefined();
    expect(store.projectFolders()).toEqual([SHOP]);
  });

  it('never writes project connections into the user state', async () => {
    const { state, store } = await setup(shared);
    await store.add(mysqlInput);
    expect(JSON.stringify(state.data.get(CONNECTIONS_STATE_KEY))).not.toContain('Dev');
  });

  it('adds a new connection to the project file, its password to the secrets only', async () => {
    const { files, secrets, store } = await setup();
    const added = await store.add(mysqlInput, 'hunter2', {}, { project: SHOP.key });
    expect(store.projectOf(added.id)).toEqual(SHOP);
    expect(files.texts.get(SHOP.key)).toContain('"local-mysql"');
    expect(files.texts.get(SHOP.key)).not.toContain('hunter2');
    expect(secrets.data.get(passwordSecretKey(added.id))).toBe('hunter2');
  });

  it('updates a project connection in its file and keeps or replaces its secrets', async () => {
    const { files, secrets, store } = await setup(shared);
    await secrets.store(sshSecretKey(devId, 'b', 'password'), 'ssh-pw');
    const updated = await store.update(
      devId,
      { name: 'Dev', driver: 'postgres', host: 'db2', ssh: store.get(devId)?.ssh },
      { kind: 'set', value: 'db-pw' },
    );
    expect(updated.host).toBe('db2');
    expect(files.texts.get(SHOP.key)).toContain('db2');
    expect(await store.getPassword(devId)).toBe('db-pw');
    expect(secrets.data.get(sshSecretKey(devId, 'b', 'password'))).toBe('ssh-pw');
  });

  it('removes a project connection from its file together with its secrets', async () => {
    const { files, secrets, store } = await setup(shared);
    await secrets.store(passwordSecretKey(devId), 'pw');
    await secrets.store(sshSecretKey(devId, 'b', 'password'), 'ssh-pw');
    await store.remove(devId);
    expect(store.get(devId)).toBeUndefined();
    expect(JSON.parse(files.texts.get(SHOP.key) ?? '{}')).toMatchObject({ connections: [] });
    expect(secrets.data.size).toBe(0);
  });

  it('sets and clears the color of a project connection in the file', async () => {
    const { files, store } = await setup(shared);
    await store.setColor(devId, 'red');
    expect(store.get(devId)?.color).toBe('red');
    await store.setColor(devId, undefined);
    expect(store.get(devId)).not.toHaveProperty('color');
    expect(files.texts.get(SHOP.key)).not.toContain('color');
  });

  it('duplicates a project connection into the user list, with its secrets', async () => {
    const { secrets, store } = await setup(shared);
    await secrets.store(passwordSecretKey(devId), 'pw');
    const copy = await store.duplicate(devId);
    expect(store.projectOf(copy.id)).toBeUndefined();
    expect(copy.name).toBe('Dev (copy)');
    expect(await store.getPassword(copy.id)).toBe('pw');
  });

  it('moves a user connection into the project with its secrets, dropping its folder', async () => {
    const { files, secrets, store } = await setup();
    await store.createFolder('Work');
    const own = await store.add(
      {
        ...mysqlInput,
        folder: 'Work',
        ssh: { id: 'h', host: 'b', user: 'u', auth: 'key', keyFile: '/k' },
      },
      'pw',
      { h: { passphrase: 'phrase' } },
    );
    const moved = await store.moveToProject(own.id, SHOP.key);
    expect(store.get(own.id)).toBeUndefined();
    expect(store.projectOf(moved.id)).toEqual(SHOP);
    expect(moved).not.toHaveProperty('folder');
    expect(await store.getPassword(moved.id)).toBe('pw');
    expect(secrets.data.get(sshSecretKey(moved.id, 'h', 'passphrase'))).toBe('phrase');
    expect(secrets.data.has(passwordSecretKey(own.id))).toBe(false);
    expect(files.texts.get(SHOP.key)).not.toContain('pw"');
  });

  it('moves a project connection to the user list with its secrets', async () => {
    const { files, secrets, store } = await setup(shared);
    await secrets.store(passwordSecretKey(devId), 'pw');
    const moved = await store.moveToUser(devId);
    expect(store.projectOf(moved.id)).toBeUndefined();
    expect(store.get(devId)).toBeUndefined();
    expect(await store.getPassword(moved.id)).toBe('pw');
    expect(secrets.data.has(passwordSecretKey(devId))).toBe(false);
    expect(JSON.parse(files.texts.get(SHOP.key) ?? '{}')).toMatchObject({ connections: [] });
  });

  it('refuses to move the wrong kind of connection', async () => {
    const { store } = await setup(shared);
    const own = await store.add(mysqlInput);
    await expect(store.moveToProject(devId, SHOP.key)).rejects.toMatchObject({ code: 'not-found' });
    await expect(store.moveToUser(own.id)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('tells listeners when the project file changes', async () => {
    const { files, projects, store } = await setup(shared);
    let calls = 0;
    store.onDidChange(() => {
      calls++;
    });
    files.texts.set(SHOP.key, JSON.stringify({ connections: [] }));
    await projects.reload(SHOP.key);
    expect(calls).toBe(1);
    expect(store.list()).toEqual([]);
  });

  it('works without project support: adding to a project is refused', async () => {
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });
    expect(store.projectFolders()).toEqual([]);
    await expect(store.add(mysqlInput, undefined, {}, { project: SHOP.key })).rejects.toMatchObject(
      { code: 'unsupported' },
    );
  });
});

describe('ConnectionStore session options (V4.9)', () => {
  const make = () =>
    new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });

  it('keeps the options the driver honours, trimmed', async () => {
    const config = await make().add({
      ...mysqlInput,
      options: {
        connectTimeout: 5,
        queryTimeout: 0,
        keepAlive: 30,
        timeZone: ' UTC ',
        charset: ' latin1 ',
        initSql: '  SET a = 1;  ',
      },
    });
    expect(config.options).toEqual({
      connectTimeout: 5,
      queryTimeout: 0,
      keepAlive: 30,
      timeZone: 'UTC',
      charset: 'latin1',
      initSql: 'SET a = 1;',
    });
  });

  it('drops empty options, a keep-alive of 0, and what the driver does not use', async () => {
    const store = make();
    expect(
      (await store.add({ ...mysqlInput, options: { keepAlive: 0, timeZone: ' ', initSql: '' } }))
        .options,
    ).toBeUndefined();
    const lite = await store.add({
      name: 'Lite',
      driver: 'sqlite',
      file: '/a.db',
      options: {
        connectTimeout: 5,
        keepAlive: 30,
        timeZone: 'UTC',
        charset: 'x',
        initSql: 'PRAGMA foreign_keys = ON',
      },
    });
    expect(lite.options).toEqual({ initSql: 'PRAGMA foreign_keys = ON' });
    const pg = await store.add({
      name: 'Pg',
      driver: 'postgres',
      host: 'h',
      options: { charset: 'latin1', timeZone: 'UTC' },
    });
    expect(pg.options).toEqual({ timeZone: 'UTC' });
  });

  it('refuses options that are out of range', async () => {
    await expect(make().add({ ...mysqlInput, options: { connectTimeout: 0 } })).rejects.toThrow(
      'connect-timeout-invalid',
    );
  });
});

describe('ConnectionStore visibility filter (V4.10)', () => {
  const make = () =>
    new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger: new RecordingLogger(),
    });

  it('keeps trimmed patterns without blanks or repeats, and only the lists the driver has', async () => {
    const store = make();
    const pg = await store.add({
      name: 'Pg',
      driver: 'postgres',
      host: 'h',
      filter: { databases: [' app_* ', 'app_*', ''], schemas: ['public'] },
    });
    expect(pg.filter).toEqual({ databases: ['app_*'], schemas: ['public'] });
    const my = await store.add({ ...mysqlInput, filter: { schemas: ['public'] } });
    expect(my.filter).toBeUndefined();
  });

  it('sets and clears the filter, keeping the rest of the connection and its password', async () => {
    const store = make();
    const config = await store.add(mysqlInput, 'pw');
    await store.setFilter(config.id, { databases: ['shop'] });
    expect(store.get(config.id)).toMatchObject({ ...mysqlInput, filter: { databases: ['shop'] } });
    await store.setFilter(config.id, undefined);
    expect(store.get(config.id)?.filter).toBeUndefined();
    expect(await store.getPassword(config.id)).toBe('pw');
    await expect(store.setFilter('nope', undefined)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('ConnectionStore Redis (V7.1)', () => {
  const sentinelInput: ConnectionInput = {
    name: 'Cache',
    driver: 'redis',
    host: ' s1 ',
    redis: {
      mode: 'sentinel',
      masterName: ' mymaster ',
      nodes: [{ host: ' s2 ', port: 26_380 }, { host: '  ' }],
      sentinelUser: ' ',
    },
  };

  function setup() {
    const state = new FakeMemento();
    const secrets = new FakeSecretStorage();
    const logger = new RecordingLogger();
    return { state, secrets, store: new ConnectionStore({ state, secrets, logger }) };
  }

  it('stores the Sentinel settings trimmed, and their password only in secrets', async () => {
    const { state, secrets, store } = setup();
    const added = await store.add(sentinelInput, 'pw', {}, { sentinelPassword: 'spw' });
    expect(added.redis).toEqual({
      mode: 'sentinel',
      masterName: 'mymaster',
      nodes: [{ host: 's2', port: 26_380 }],
    });
    expect(added.host).toBe('s1');
    expect(await store.getSentinelPassword(added.id)).toBe('spw');
    expect(secrets.data.get(sentinelSecretKey(added.id))).toBe('spw');
    expect(JSON.stringify(state.data.get(CONNECTIONS_STATE_KEY))).not.toContain('spw');
  });

  it('keeps no Redis settings for one server, nor for another driver', async () => {
    const { store } = setup();
    const single = await store.add({
      name: 'R',
      driver: 'redis',
      host: 'h',
      redis: { mode: 'standalone' },
    });
    expect(single.redis).toBeUndefined();
    const sql = await store.add({ ...mysqlInput, redis: { mode: 'cluster' } });
    expect(sql.redis).toBeUndefined();
  });

  it('drops the master name and Sentinel user of a cluster', async () => {
    const { store } = setup();
    const added = await store.add({
      name: 'C',
      driver: 'redis',
      host: 'n1',
      redis: { mode: 'cluster', masterName: 'm', sentinelUser: 'u' },
    });
    expect(added.redis).toEqual({ mode: 'cluster' });
  });

  it('ignores a Sentinel password for a connection that does not use Sentinels', async () => {
    const { secrets, store } = setup();
    const added = await store.add(
      { name: 'R', driver: 'redis', host: 'h' },
      undefined,
      {},
      {
        sentinelPassword: 'spw',
      },
    );
    expect(secrets.data.has(sentinelSecretKey(added.id))).toBe(false);
  });

  it('refuses invalid Redis settings', async () => {
    const { store } = setup();
    await expect(
      store.add({ name: 'R', driver: 'redis', host: 'h', redis: { mode: 'sentinel' } }),
    ).rejects.toMatchObject({
      code: 'unsupported',
      message: expect.stringContaining('redis-master-empty') as unknown,
    });
    await expect(
      store.add({ name: 'R', driver: 'redis', host: 'h', database: 'x' }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('redis-database-invalid') as unknown,
    });
  });

  it('keeps, replaces and clears the Sentinel password on update', async () => {
    const { store } = setup();
    const added = await store.add(sentinelInput, undefined, {}, { sentinelPassword: 'one' });
    await store.update(added.id, sentinelInput);
    expect(await store.getSentinelPassword(added.id)).toBe('one');
    await store.update(
      added.id,
      sentinelInput,
      { kind: 'keep' },
      {},
      { kind: 'set', value: 'two' },
    );
    expect(await store.getSentinelPassword(added.id)).toBe('two');
    await store.update(added.id, sentinelInput, { kind: 'keep' }, {}, { kind: 'clear' });
    expect(await store.getSentinelPassword(added.id)).toBeUndefined();
  });

  it('erases the Sentinel password when the connection stops using Sentinels', async () => {
    const { store } = setup();
    const added = await store.add(sentinelInput, undefined, {}, { sentinelPassword: 'one' });
    await store.update(
      added.id,
      { name: 'Cache', driver: 'redis', host: 'n1', redis: { mode: 'cluster' } },
      { kind: 'keep' },
      {},
      { kind: 'set', value: 'ignored' },
    );
    expect(await store.getSentinelPassword(added.id)).toBeUndefined();
  });

  it('copies the Sentinel password with a duplicate and deletes it with the connection', async () => {
    const { secrets, store } = setup();
    const added = await store.add(sentinelInput, undefined, {}, { sentinelPassword: 'spw' });
    const copy = await store.duplicate(added.id);
    expect(await store.getSentinelPassword(copy.id)).toBe('spw');
    await store.remove(added.id);
    expect(secrets.data.has(sentinelSecretKey(added.id))).toBe(false);
    expect(await store.getSentinelPassword(copy.id)).toBe('spw');
  });
});
