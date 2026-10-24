import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ConnectionInput } from '../../../src/shared/connection';
import {
  CONNECTIONS_STATE_KEY,
  ConnectionStore,
  passwordSecretKey,
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
});
