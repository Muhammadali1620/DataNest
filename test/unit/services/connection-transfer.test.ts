import { describe, expect, it } from 'vitest';
import { ConnectionStore } from '../../../src/services/connection-store';
import {
  exportConnections,
  importConnections,
  readImport,
} from '../../../src/services/connection-transfer';
import type { ConnectionConfig } from '../../../src/shared/connection';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

function makeStore() {
  const secrets = new FakeSecretStorage();
  const store = new ConnectionStore({
    state: new FakeMemento(),
    secrets,
    logger: new RecordingLogger(),
  });
  return { store, secrets };
}

const shop: ConnectionConfig = {
  id: 'uuid-1',
  name: 'Shop',
  driver: 'postgres',
  host: 'db',
  port: 5432,
  user: 'app',
  folder: 'Work',
  production: true,
  ssh: { id: 'h1', host: 'bastion', user: 'u', auth: 'agent' },
};
const lite: ConnectionConfig = { id: 'uuid-2', name: 'Lite', driver: 'sqlite', file: '/data/a.db' };

describe('exportConnections', () => {
  it('writes the connections without ids, and the order of the folders they use', () => {
    const text = exportConnections([shop, lite], ['Home', 'Work', 'Empty']);
    const parsed = JSON.parse(text) as {
      version: number;
      folders: string[];
      connections: object[];
    };
    expect(parsed.version).toBe(1);
    expect(parsed.folders).toEqual(['Work']);
    expect(parsed.connections).toEqual([
      {
        name: 'Shop',
        driver: 'postgres',
        host: 'db',
        port: 5432,
        user: 'app',
        folder: 'Work',
        production: true,
        ssh: { id: 'h1', host: 'bastion', user: 'u', auth: 'agent' },
      },
      { name: 'Lite', driver: 'sqlite', file: '/data/a.db' },
    ]);
    expect(text).not.toContain('uuid-');
  });

  it('never writes a secret: there is nowhere in a config to keep one', async () => {
    const { store } = makeStore();
    const saved = await store.add(
      {
        name: 'S',
        driver: 'mysql',
        host: 'h',
        ssh: { id: 'x', host: 'b', user: 'u', auth: 'password' },
      },
      'db-secret',
      { x: { password: 'ssh-secret' } },
    );
    const text = exportConnections([saved], store.folders());
    expect(text).not.toContain('db-secret');
    expect(text).not.toContain('ssh-secret');
  });

  it('writes an empty list when nothing is chosen', () => {
    expect(JSON.parse(exportConnections([], ['Work']))).toEqual({ version: 1, connections: [] });
  });
});

describe('readImport', () => {
  it('offers every readable connection, marking those already saved', () => {
    const text = exportConnections([shop, lite], ['Work']);
    const read = readImport(text, [{ ...lite, id: 'mine', name: 'My copy' }]);
    expect(read.ok).toBe(true);
    if (!read.ok) {
      return;
    }
    expect(read.plan.candidates.map((candidate) => candidate.input.name)).toEqual(['Shop', 'Lite']);
    expect(read.plan.candidates[0]?.known).toBeUndefined();
    expect(read.plan.candidates[1]?.known?.name).toBe('My copy');
    expect(read.plan.folders).toEqual(['Work']);
    expect(read.plan.skipped).toEqual([]);
  });

  it('reports entries it cannot read by position and keeps the rest', () => {
    const read = readImport(
      JSON.stringify({
        connections: [
          { name: 'A', driver: 'mysql', host: 'h' },
          { name: 'B', driver: 'nosql' },
        ],
      }),
      [],
    );
    expect(read.ok && read.plan.candidates).toHaveLength(1);
    expect(read.ok && read.plan.skipped[0]?.position).toBe(2);
  });

  it('refuses a file that is not a connection file', () => {
    expect(readImport('[1, 2]', [])).toMatchObject({ ok: false });
    expect(readImport('not json', [])).toMatchObject({ ok: false });
  });
});

describe('importConnections', () => {
  it('adds the chosen connections with new ids, creating their folders in file order', async () => {
    const { store } = makeStore();
    await store.createFolder('Existing');
    const added = await importConnections(
      store,
      [
        { name: 'A', driver: 'mysql', host: 'h', folder: 'Second' },
        { name: 'B', driver: 'mysql', host: 'h', folder: 'First' },
        { name: 'C', driver: 'mysql', host: 'h', folder: 'Existing' },
        { name: 'D', driver: 'mysql', host: 'h' },
      ],
      ['First', 'Unused', 'Second'],
    );
    expect(added.map((config) => config.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(new Set(added.map((config) => config.id)).size).toBe(4);
    expect(store.folders()).toEqual(['Existing', 'First', 'Second']);
    expect(store.get(added[0]?.id ?? '')?.folder).toBe('Second');
  });

  it('round-trips an export into another store, without passwords', async () => {
    const source = makeStore();
    await source.store.createFolder('Work');
    await source.store.add({ name: 'Shop', driver: 'mysql', host: 'h', folder: 'Work' }, 'secret');
    const text = exportConnections(source.store.list(), source.store.folders());
    const target = makeStore();
    const read = readImport(text, target.store.list());
    if (!read.ok) {
      throw new Error(read.error);
    }
    const [added] = await importConnections(
      target.store,
      read.plan.candidates.map((candidate) => candidate.input),
      read.plan.folders,
    );
    expect(added).toMatchObject({ name: 'Shop', driver: 'mysql', host: 'h', folder: 'Work' });
    expect(await target.store.getPassword(added?.id ?? '')).toBeUndefined();
    expect(target.secrets.data.size).toBe(0);
  });

  it('ignores a blank folder name', async () => {
    const { store } = makeStore();
    await importConnections(store, [{ name: 'A', driver: 'mysql', host: 'h', folder: '  ' }], []);
    expect(store.folders()).toEqual([]);
  });
});
