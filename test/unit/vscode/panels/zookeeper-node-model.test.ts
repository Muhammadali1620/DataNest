import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { redisValueOf } from '../../../../src/shared/redis-value';
import {
  nameProblemText,
  ZookeeperNodeModel,
} from '../../../../src/vscode/panels/zookeeper-node-model';
import { FakeZookeeperSession, MemoryTree } from '../../../helpers/fake-zookeeper-driver';

let tree: MemoryTree;
let session: FakeZookeeperSession;

function model(path: string, readOnly = false): ZookeeperNodeModel {
  return new ZookeeperNodeModel({
    path,
    connectionName: 'Ensemble',
    readOnly,
    session: () => Promise.resolve(session),
  });
}

const text = (path: string): string =>
  new TextDecoder().decode(tree.nodes.get(path)?.data ?? new Uint8Array());

beforeEach(() => {
  tree = new MemoryTree();
  session = new FakeZookeeperSession(tree);
  tree.put('/app', 'hello');
  tree.put('/app/b');
  tree.put('/app/a');
});

describe('state', () => {
  it('is empty before the first read', () => {
    const state = model('/app').state();
    expect(state).toMatchObject({
      path: '/app',
      connectionName: 'Ensemble',
      readOnly: false,
      exists: false,
      size: 0,
      version: 0,
      kind: 'persistent',
      children: [],
      acl: [],
    });
    expect(state.value).toBeUndefined();
    expect(state.conflict).toBeUndefined();
  });

  it('shows the znode once it is read: data, stat, ACL, sorted children', async () => {
    const one = model('/app');
    const state = await one.refresh();
    expect(state).toMatchObject({
      exists: true,
      size: 5,
      version: 0,
      numChildren: 2,
      children: ['a', 'b'],
      moreChildren: false,
      czxid: '1',
      mzxid: '2',
      ctime: 1_700_000_000_000,
    });
    expect(state.value).toEqual(redisValueOf(new TextEncoder().encode('hello')));
    expect(state.acl).toEqual([{ perms: 31, scheme: 'world', id: 'anyone' }]);
    expect(one.currentPath).toBe('/app');
  });

  it('tells an ephemeral znode by its owner', async () => {
    tree.put('/eph', 'x', '72057594037927937');
    const state = await model('/eph').refresh();
    expect(state).toMatchObject({ kind: 'ephemeral', ephemeralOwner: '72057594037927937' });
  });

  it('says a znode that is not there does not exist', async () => {
    const state = await model('/nothing').refresh();
    expect(state.exists).toBe(false);
  });

  it('says so when the ACL hides the data', async () => {
    const node = tree.nodes.get('/app');
    const real = session.getData.bind(session);
    session.getData = () => Promise.reject(new DbError('permission-denied', 'no'));
    session.exists = () => Promise.reject(new DbError('permission-denied', 'no'));
    const state = await model('/app').refresh();
    expect(state).toMatchObject({ exists: true, denied: true });
    expect(state.value).toBeUndefined();
    session.getData = real;
    expect(node).toBeDefined();
  });
});

describe('save', () => {
  it('writes the text and reads the znode again', async () => {
    const one = model('/app');
    const loaded = await one.refresh();
    const result = await one.save({ text: 'changed' }, loaded.version);
    expect(result.saved).toBe(true);
    expect(result.state).toMatchObject({ version: 1, size: 7 });
    expect(text('/app')).toBe('changed');
  });

  it('writes hex bytes as bytes', async () => {
    const one = model('/app');
    await one.refresh();
    await one.save({ text: '\\x00\\xff', hex: '00ff' }, 0);
    expect([...(tree.nodes.get('/app')?.data ?? [])]).toEqual([0, 255]);
  });

  it('refuses a znode that changed since it was read, and keeps the new content', async () => {
    const one = model('/app');
    const loaded = await one.refresh();
    await session.setData('/app', new TextEncoder().encode('theirs'), -1);
    const result = await one.save({ text: 'mine' }, loaded.version);
    expect(result.saved).toBe(false);
    expect(result.state).toMatchObject({ conflict: true, version: 1 });
    expect(result.state.value?.text).toBe('theirs');
    expect(text('/app')).toBe('theirs');
    // The next read is a plain one.
    expect((await one.refresh()).conflict).toBeUndefined();
  });

  it('replaces it anyway when told to, against the version that is there now', async () => {
    const one = model('/app');
    await one.refresh();
    await session.setData('/app', new TextEncoder().encode('theirs'), -1);
    const result = await one.save({ text: 'mine' }, 0, true);
    expect(result.saved).toBe(true);
    expect(text('/app')).toBe('mine');
  });

  it('creates a znode that was not there', async () => {
    const one = model('/app/new');
    expect((await one.refresh()).exists).toBe(false);
    const result = await one.save({ text: 'fresh' }, 0);
    expect(result.saved).toBe(true);
    expect(result.state.exists).toBe(true);
    expect(text('/app/new')).toBe('fresh');
  });

  it('calls it a conflict when somebody made the znode first', async () => {
    const one = model('/app/new');
    await one.refresh();
    tree.put('/app/new', 'theirs');
    const result = await one.save({ text: 'mine' }, 0);
    expect(result.saved).toBe(false);
    expect(result.state.conflict).toBe(true);
    expect(text('/app/new')).toBe('theirs');
  });

  it('lets a missing parent through as the error it is', async () => {
    const one = model('/nowhere/new');
    await one.refresh();
    await expect(one.save({ text: 'x' }, 0)).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses a value that is cut short or has odd hex digits', async () => {
    const one = model('/app');
    await one.refresh();
    await expect(one.save({ text: 'x', truncated: true }, 0)).rejects.toMatchObject({
      code: 'syntax',
    });
    await expect(one.save({ text: 'x', hex: '0' }, 0)).rejects.toMatchObject({ code: 'syntax' });
  });

  it('refuses on a read-only connection', async () => {
    await expect(model('/app', true).save({ text: 'x' }, 0)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(text('/app')).toBe('hello');
  });
});

describe('createChild', () => {
  it('makes a child with empty data and shows it in the list', async () => {
    const one = model('/app');
    await one.refresh();
    expect(await one.createChild('c', 'persistent')).toBe('/app/c');
    expect(text('/app/c')).toBe('');
    expect(one.state().children).toEqual(['a', 'b', 'c']);
  });

  it('returns the path a sequential child got', async () => {
    const one = model('/app');
    await one.refresh();
    expect(await one.createChild('job-', 'sequential')).toBe('/app/job-0000000000');
  });

  it('refuses a name that is no name, a taken one and a read-only connection', async () => {
    const one = model('/app');
    await expect(one.createChild('', 'persistent')).rejects.toMatchObject({ code: 'syntax' });
    await expect(one.createChild('a/b', 'persistent')).rejects.toMatchObject({ code: 'syntax' });
    await expect(one.createChild('..', 'persistent')).rejects.toMatchObject({ code: 'syntax' });
    await expect(one.createChild('a', 'persistent')).rejects.toMatchObject({ code: 'constraint' });
    await expect(model('/app', true).createChild('c', 'persistent')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('deleteNode', () => {
  it('deletes the znode with everything below it', async () => {
    tree.put('/app/a/deep');
    const state = await model('/app').deleteNode();
    expect(state.exists).toBe(false);
    expect([...tree.nodes.keys()]).toEqual(['/']);
  });

  it('refuses on a read-only connection, and for the root', async () => {
    await expect(model('/app', true).deleteNode()).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(model('/').deleteNode()).rejects.toMatchObject({ code: 'unsupported' });
    expect(tree.nodes.has('/app')).toBe(true);
  });
});

describe('nameProblemText', () => {
  it('has words for every problem and none for no problem', () => {
    for (const problem of ['empty', 'slash', 'dots', 'null', 'long'] as const) {
      expect(nameProblemText(problem)).not.toBe('');
    }
    expect(nameProblemText(undefined)).toBe('');
  });
});
