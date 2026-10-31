import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SavedQueryStore } from '../../../../src/services/saved-queries';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { savedQueryCommandHandlers } from '../../../../src/vscode/tree/saved-query-commands';

const SCOPE = { database: 'app', schema: 'public' };
const folder: TreeNode = { kind: 'queryFolder', connectionId: 'c1', scope: SCOPE };

describe('saved query commands (V11.12)', () => {
  let root: string;
  let store: SavedQueryStore;
  let names: (string | undefined)[];
  let asked: { title: string; value: string; validate: (name: string) => string | undefined }[];
  let confirm: boolean;
  let confirmed: string[];
  let opened: { connectionId: string; path: string }[];
  let errors: string[];
  const refresh = vi.fn();

  function handlers() {
    return savedQueryCommandHandlers({
      store,
      tree: { refresh },
      open: (connectionId, _scope, path) => {
        opened.push({ connectionId, path });
        return Promise.resolve();
      },
      askName: (options) => {
        asked.push(options);
        return Promise.resolve(names.shift());
      },
      confirmDelete: (title) => {
        confirmed.push(title);
        return Promise.resolve(confirm);
      },
      showError: (message) => {
        errors.push(message);
      },
      texts: {
        newName: 'New name',
        renameTo: (name) => `Rename ${name}`,
        deleteQuery: (name) => `Delete ${name}?`,
        delete: 'Delete',
        failed: (message) => `Failed: ${message}`,
      },
    });
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'datanest-saved-'));
    store = new SavedQueryStore(root);
    names = [];
    asked = [];
    confirm = true;
    confirmed = [];
    opened = [];
    errors = [];
    refresh.mockClear();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates a query under the name given, refreshes the folder and opens the file', async () => {
    names = ['report'];
    await handlers().newSavedQuery(folder);
    expect(asked[0]).toMatchObject({ title: 'New name', value: 'query' });
    expect(await store.list('c1', SCOPE)).toEqual(['report']);
    expect(refresh).toHaveBeenCalledWith(folder);
    expect(opened).toEqual([{ connectionId: 'c1', path: store.pathOf('c1', SCOPE, 'report') }]);
    expect(await readFile(store.pathOf('c1', SCOPE, 'report'), 'utf8')).toBe('');
  });

  it('does nothing when the name box is cancelled, or the target is not a folder', async () => {
    names = [undefined];
    await handlers().newSavedQuery(folder);
    await handlers().newSavedQuery({ kind: 'connection', connectionId: 'c1' });
    await handlers().newSavedQuery();
    expect(await store.list('c1', SCOPE)).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('validates the name as it is typed', async () => {
    names = [undefined];
    await handlers().newSavedQuery(folder);
    const { validate } = asked[0] ?? { validate: () => 'missing' };
    expect(validate('fine.sql')).toBeUndefined();
    expect(validate('a/b')).toBeDefined();
    expect(validate('  ')).toBeDefined();
  });

  it('opens a saved query from its file', async () => {
    const { name } = await store.create('c1', SCOPE, 'report');
    await handlers().openSavedQuery({ kind: 'savedQuery', connectionId: 'c1', scope: SCOPE, name });
    expect(opened).toEqual([{ connectionId: 'c1', path: store.pathOf('c1', SCOPE, 'report') }]);
  });

  it('renames, refreshing the folder the query lives in', async () => {
    await store.create('c1', SCOPE, 'a');
    names = ['b'];
    await handlers().renameSavedQuery({
      kind: 'savedQuery',
      connectionId: 'c1',
      scope: SCOPE,
      name: 'a',
    });
    expect(await store.list('c1', SCOPE)).toEqual(['b']);
    expect(refresh).toHaveBeenCalledWith(folder);
    expect(asked[0]).toMatchObject({ title: 'Rename a', value: 'a' });
  });

  it('lets the old name pass validation and leaves a same-name rename alone', async () => {
    await store.create('c1', SCOPE, 'a');
    names = ['a.sql'];
    await handlers().renameSavedQuery({
      kind: 'savedQuery',
      connectionId: 'c1',
      scope: SCOPE,
      name: 'a',
    });
    expect(asked[0]?.validate('a')).toBeUndefined();
    expect(refresh).not.toHaveBeenCalled();
    expect(await store.list('c1', SCOPE)).toEqual(['a']);
  });

  it('shows the reason when a rename hits a taken name, and keeps both files', async () => {
    await store.create('c1', SCOPE, 'a');
    await store.create('c1', SCOPE, 'b');
    names = ['b'];
    await handlers().renameSavedQuery({
      kind: 'savedQuery',
      connectionId: 'c1',
      scope: SCOPE,
      name: 'a',
    });
    expect(errors).toEqual(['Failed: A saved query named "b" already exists']);
    expect(await store.list('c1', SCOPE)).toEqual(['a', 'b']);
  });

  it('deletes after a yes, and keeps the file after a no', async () => {
    await store.create('c1', SCOPE, 'a');
    const node: TreeNode = { kind: 'savedQuery', connectionId: 'c1', scope: SCOPE, name: 'a' };
    confirm = false;
    await handlers().deleteSavedQuery(node);
    expect(confirmed).toEqual(['Delete a?']);
    expect(await store.list('c1', SCOPE)).toEqual(['a']);
    confirm = true;
    await handlers().deleteSavedQuery(node);
    expect(await store.list('c1', SCOPE)).toEqual([]);
    expect(refresh).toHaveBeenCalledWith(folder);
  });
});
