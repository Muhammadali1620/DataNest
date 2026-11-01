import { describe, expect, it, vi } from 'vitest';
import type {
  ExportReport,
  RestorePolicy,
  RestoreReport,
} from '../../../../src/services/redis/key-files';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import {
  type KeyFileSink,
  type KeyFileUi,
  redisKeyFileCommandHandlers,
} from '../../../../src/vscode/redis/redis-key-file-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { MemoryRedis } from '../../../helpers/memory-redis';

const database: TreeNode = {
  kind: 'redisDatabase',
  connectionId: 'r1',
  database: 3,
  keys: 0,
};
const folder: TreeNode = {
  kind: 'redisFolder',
  connectionId: 'r1',
  database: 3,
  path: ['user'],
  prefix: 'user:',
  count: 2,
};
const keyNode = (name: string): TreeNode => ({
  kind: 'redisKey',
  connectionId: 'r1',
  database: 3,
  key: { text: name },
  name,
});

function setup(
  options: {
    config?: Partial<ConnectionConfig>;
    save?: string | undefined;
    open?: string | undefined;
    policy?: RestorePolicy | undefined;
    confirm?: boolean;
    content?: string;
    cancelAt?: number;
  } = {},
) {
  const redis = new MemoryRedis();
  redis.string('user:1', 'a');
  redis.string('user:2', 'b');
  redis.string('other', 'c');
  const config: ConnectionConfig = {
    id: 'r1',
    name: 'Cache',
    driver: 'redis',
    host: 'h',
    ...options.config,
  };
  const written: string[] = [];
  const sink: KeyFileSink & { closed: boolean; discarded: boolean } = {
    closed: false,
    discarded: false,
    write: (piece) => {
      written.push(piece);
      return Promise.resolve();
    },
    close: () => {
      sink.closed = true;
      return Promise.resolve();
    },
    discard: () => {
      sink.discarded = true;
      return Promise.resolve();
    },
  };
  const exported: [ExportReport, string][] = [];
  const restored: [RestoreReport, string][] = [];
  const titles: string[] = [];
  const ui: KeyFileUi = {
    pickSaveFile: vi.fn(() => Promise.resolve('save' in options ? options.save : '/tmp/out.jsonl')),
    pickOpenFile: vi.fn(() => Promise.resolve('open' in options ? options.open : '/tmp/in.jsonl')),
    askPolicy: vi.fn(() =>
      Promise.resolve('policy' in options ? options.policy : { kind: 'overwrite' as const }),
    ),
    confirm: vi.fn(() => Promise.resolve(options.confirm ?? true)),
    withProgress: async (title, task) => {
      titles.push(title);
      return await task({ aborted: false }, () => undefined);
    },
    showExported: (report, path) => exported.push([report, path]),
    showRestored: (report, place) => restored.push([report, place]),
  };
  const browser = {
    session: vi.fn(() => Promise.resolve(redis)),
    reset: vi.fn(),
  };
  const tree = { refresh: vi.fn() };
  const handlers = redisKeyFileCommandHandlers({
    browser,
    store: { get: (id) => (id === 'r1' ? config : undefined) },
    tree,
    ui,
    texts: {
      readOnly: 'READ ONLY',
      exportTitle: (what) => `export ${what}`,
      restoreTitle: (what) => `restore ${what}`,
      keysDone: (count) => `${count} done`,
      productionQuestion: (name) => `production ${name}`,
      restoreAction: 'Restore',
    },
    openSink: vi.fn(() => Promise.resolve(sink)),
    readChunks: vi.fn(() =>
      (async function* () {
        await Promise.resolve();
        yield { text: options.content ?? '' };
      })(),
    ),
    fileNameFor: (value) => value.replaceAll(/[^\w]/g, '_'),
  });
  return { handlers, redis, ui, browser, tree, sink, written, exported, restored, titles };
}

const records = (written: string[]): Record<string, unknown>[] =>
  written
    .join('')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('exportKeys (V13.9)', () => {
  it('writes the whole database from a database node and closes the file', async () => {
    const { handlers, sink, written, exported, titles, ui } = setup();
    await handlers.exportKeys(database);
    expect(
      records(written)
        .slice(1)
        .map((record) => record.key)
        .sort(),
    ).toEqual(['other', 'user:1', 'user:2']);
    expect(sink.closed).toBe(true);
    expect(sink.discarded).toBe(false);
    expect(exported[0]?.[1]).toBe('/tmp/out.jsonl');
    expect(exported[0]?.[0].keys).toBe(3);
    expect(titles).toEqual(['export Cache #3']);
    expect(ui.pickSaveFile).toHaveBeenCalledWith('Cache__3.redis.jsonl');
  });

  it('writes only the keys under the prefix of a folder', async () => {
    const { handlers, written, titles, ui } = setup();
    await handlers.exportKeys(folder);
    expect(
      records(written)
        .slice(1)
        .map((record) => record.key)
        .sort(),
    ).toEqual(['user:1', 'user:2']);
    expect(titles).toEqual(['export Cache #3 user:']);
    expect(ui.pickSaveFile).toHaveBeenCalledWith('Cache__3_user_.redis.jsonl');
  });

  it('writes the selected keys when the clicked one is among them', async () => {
    const { handlers, written } = setup();
    await handlers.exportKeys(keyNode('other'), [keyNode('other'), keyNode('user:2')]);
    expect(
      records(written)
        .slice(1)
        .map((record) => record.key),
    ).toEqual(['other', 'user:2']);
  });

  it('writes only the clicked key when it is not in the selection', async () => {
    const { handlers, written } = setup();
    await handlers.exportKeys(keyNode('other'), [keyNode('user:1')]);
    expect(
      records(written)
        .slice(1)
        .map((record) => record.key),
    ).toEqual(['other']);
  });

  it('ignores selected keys of another database', async () => {
    const { handlers, written } = setup();
    const elsewhere: TreeNode = { ...(keyNode('user:1') as object), database: 9 } as TreeNode;
    await handlers.exportKeys(keyNode('other'), [keyNode('other'), elsewhere]);
    expect(
      records(written)
        .slice(1)
        .map((record) => record.key),
    ).toEqual(['other']);
  });

  it('does nothing when the user backs out of the dialog', async () => {
    const { handlers, sink, written } = setup({ save: undefined });
    await handlers.exportKeys(database);
    expect(written).toEqual([]);
    expect(sink.closed).toBe(false);
  });

  it('does nothing for a node that is not a Redis one, or for no node', async () => {
    const { handlers, ui } = setup();
    await handlers.exportKeys(undefined);
    await handlers.exportKeys('r1');
    await handlers.exportKeys({ kind: 'connection', connectionId: 'r1' });
    expect(ui.pickSaveFile).not.toHaveBeenCalled();
  });

  it('throws away the file of a failure', async () => {
    const { handlers, sink, redis } = setup();
    redis.pipeline = () => Promise.reject(new Error('boom'));
    await expect(handlers.exportKeys(database)).rejects.toThrow();
    expect(sink.discarded).toBe(true);
    expect(sink.closed).toBe(false);
  });

  it('throws away the file of a cancelled export', async () => {
    const { handlers, sink, ui, exported } = setup();
    ui.withProgress = async (_title, task) => await task({ aborted: true }, () => undefined);
    await handlers.exportKeys(database);
    expect(sink.discarded).toBe(true);
    expect(exported[0]?.[0].cancelled).toBe(true);
  });

  it('needs no question on a read-only or production connection: it only reads', async () => {
    const { handlers, ui, sink } = setup({ config: { readOnly: true, production: true } });
    await handlers.exportKeys(database);
    expect(ui.confirm).not.toHaveBeenCalled();
    expect(sink.closed).toBe(true);
  });
});

describe('restoreKeys (V13.9)', () => {
  const file = [
    JSON.stringify({ datanest: 'redis-keys', version: 1 }),
    JSON.stringify({ key: 'n1', type: 'string', ttl: null, value: 'x' }),
    JSON.stringify({ key: 'user:1', type: 'string', ttl: null, value: 'from file' }),
  ].join('\n');

  it('reads the file, applies the policy and refreshes the database', async () => {
    const { handlers, redis, restored, browser, tree, titles } = setup({ content: file });
    await handlers.restoreKeys(database);
    expect(restored[0]?.[0]).toMatchObject({ restored: 2, failed: 0 });
    expect(restored[0]?.[1]).toBe('Cache #3');
    expect(redis.entryOf('n1')).toBeDefined();
    expect(titles).toEqual(['restore Cache #3']);
    expect(browser.reset).toHaveBeenCalledWith('r1', 3);
    expect(tree.refresh).toHaveBeenCalledWith({
      kind: 'redisDatabase',
      connectionId: 'r1',
      database: 3,
      keys: 0,
    });
  });

  it('works from a folder or a key as well, in their database', async () => {
    const { handlers, browser } = setup({ content: file });
    await handlers.restoreKeys(folder);
    await handlers.restoreKeys(keyNode('x'));
    expect(browser.session).toHaveBeenCalledWith('r1', 3);
  });

  it('refuses a read-only connection before asking anything', async () => {
    const { handlers, ui } = setup({ config: { readOnly: true }, content: file });
    await expect(handlers.restoreKeys(database)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'READ ONLY',
    });
    expect(ui.pickOpenFile).not.toHaveBeenCalled();
  });

  it('asks once on production and writes nothing when refused', async () => {
    const { handlers, ui, redis, restored } = setup({
      config: { production: true },
      confirm: false,
      content: file,
    });
    await handlers.restoreKeys(database);
    expect(ui.confirm).toHaveBeenCalledWith('production Cache', undefined, 'Restore');
    expect(redis.entryOf('n1')).toBeUndefined();
    expect(restored).toEqual([]);
  });

  it('writes after a yes on production', async () => {
    const { handlers, redis } = setup({ config: { production: true }, content: file });
    await handlers.restoreKeys(database);
    expect(redis.entryOf('n1')).toBeDefined();
  });

  it('does not ask on an ordinary connection', async () => {
    const { handlers, ui } = setup({ content: file });
    await handlers.restoreKeys(database);
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it('does nothing when the user backs out of the file or of the policy', async () => {
    const noFile = setup({ open: undefined, content: file });
    await noFile.handlers.restoreKeys(database);
    expect(noFile.ui.askPolicy).not.toHaveBeenCalled();
    const noPolicy = setup({ policy: undefined, content: file });
    await noPolicy.handlers.restoreKeys(database);
    expect(noPolicy.redis.entryOf('n1')).toBeUndefined();
    expect(noPolicy.restored).toEqual([]);
    expect(noPolicy.tree.refresh).not.toHaveBeenCalled();
  });

  it('does nothing for a node that is not a Redis one', async () => {
    const { handlers, ui } = setup({ content: file });
    await handlers.restoreKeys(undefined);
    await handlers.restoreKeys({ kind: 'connection', connectionId: 'r1' });
    expect(ui.pickOpenFile).not.toHaveBeenCalled();
  });

  it('uses the policy it was given', async () => {
    const skip = setup({ policy: { kind: 'skip' }, content: file });
    await skip.handlers.restoreKeys(database);
    expect(skip.restored[0]?.[0]).toMatchObject({ restored: 1, skipped: 1 });
    const prefix = setup({ policy: { kind: 'prefix', prefix: 'p:' }, content: file });
    await prefix.handlers.restoreKeys(database);
    expect(prefix.redis.entryOf('p:n1')).toBeDefined();
  });

  it('refreshes the tree even when the restore fails midway', async () => {
    const { handlers, redis, tree, restored } = setup({ content: file });
    redis.call = () => Promise.reject(new Error('link lost'));
    await expect(handlers.restoreKeys(database)).rejects.toThrow('link lost');
    expect(tree.refresh).toHaveBeenCalled();
    expect(restored).toEqual([]);
  });
});
