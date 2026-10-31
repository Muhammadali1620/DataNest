import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SavedQueryStore,
  savedQueryName,
  savedQueryNameProblem,
  SAVED_QUERY_NAME_LIMIT,
} from '../../../src/services/saved-queries';

describe('savedQueryNameProblem', () => {
  it('accepts ordinary names, spaces and non-Latin ones included', () => {
    for (const name of [
      'report',
      'monthly report',
      'отчёт 2026',
      'a.b',
      'x'.repeat(SAVED_QUERY_NAME_LIMIT),
    ]) {
      expect(savedQueryNameProblem(name), name).toBeUndefined();
    }
  });

  it('refuses empty names, path characters, dots and long names', () => {
    for (const name of [
      '',
      '   ',
      'a/b',
      'a\\b',
      'a:b',
      'a*',
      'a?',
      '"a"',
      '<a>',
      'a|b',
      '.',
      '..',
      'a\u0000b',
      'x'.repeat(SAVED_QUERY_NAME_LIMIT + 1),
    ]) {
      expect(savedQueryNameProblem(name), JSON.stringify(name)).toBeDefined();
    }
  });
});

describe('savedQueryName', () => {
  it('drops the extension and the spaces around the name', () => {
    expect(savedQueryName('  report.sql ')).toBe('report');
    expect(savedQueryName('REPORT.SQL')).toBe('REPORT');
    expect(savedQueryName('report')).toBe('report');
    expect(savedQueryName('a.sql.sql')).toBe('a.sql');
  });
});

describe('SavedQueryStore', () => {
  let root: string;
  let store: SavedQueryStore;
  const scope = { database: 'app', schema: 'public' };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'datanest-queries-'));
    store = new SavedQueryStore(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists nothing for a place never used', async () => {
    expect(await store.list('c1', scope)).toEqual([]);
  });

  it('creates files and lists their names in natural order', async () => {
    await store.create('c1', scope, 'query 10');
    await store.create('c1', scope, 'query 2');
    await store.create('c1', scope, 'alpha');
    expect(await store.list('c1', scope)).toEqual(['alpha', 'query 2', 'query 10']);
  });

  it('writes the content and never overwrites: a taken name gets a number', async () => {
    const first = await store.create('c1', scope, 'q', 'SELECT 1');
    const second = await store.create('c1', scope, 'q', 'SELECT 2');
    const third = await store.create('c1', scope, 'q.sql');
    expect([first.name, second.name, third.name]).toEqual(['q', 'q-2', 'q-3']);
    expect(await readFile(first.path, 'utf8')).toBe('SELECT 1');
    expect(await readFile(second.path, 'utf8')).toBe('SELECT 2');
  });

  it('names the first query "query" by default', async () => {
    expect((await store.create('c1', scope)).name).toBe('query');
  });

  it('refuses a bad name without creating anything', async () => {
    await expect(store.create('c1', scope, 'a/b')).rejects.toThrow();
    await expect(store.create('c1', scope, '')).rejects.toThrow();
    expect(await store.list('c1', scope)).toEqual([]);
  });

  it('keeps connections, databases and schemas apart', async () => {
    await store.create('c1', scope, 'one');
    expect(await store.list('c2', scope)).toEqual([]);
    expect(await store.list('c1', { database: 'app' })).toEqual([]);
    expect(await store.list('c1', { database: 'app', schema: 'other' })).toEqual([]);
    expect(await store.list('c1', {})).toEqual([]);
  });

  it('cannot be led out of its folder by a name', () => {
    const odd = store.folderOf('../x', { database: '..', schema: 'a/b' });
    expect(odd.startsWith(root)).toBe(true);
    expect(odd).not.toContain('..');
    expect(store.folderOf('c', { database: 'a b' })).not.toBe(
      store.folderOf('c', { database: 'a_b' }),
    );
  });

  it('ignores files that are not SQL and folders', async () => {
    const { path } = await store.create('c1', scope, 'real');
    await writeFile(join(path, '..', 'notes.txt'), 'x');
    await writeFile(join(path, '..', 'UPPER.SQL'), 'x');
    expect(await store.list('c1', scope)).toEqual(['real', 'UPPER']);
  });

  it('renames a query and refuses a name that is taken', async () => {
    await store.create('c1', scope, 'a', 'SELECT 1');
    await store.create('c1', scope, 'b');
    const target = await store.rename('c1', scope, 'a', 'c.sql');
    expect(target).toBe(store.pathOf('c1', scope, 'c'));
    expect(await readFile(target, 'utf8')).toBe('SELECT 1');
    expect(await store.list('c1', scope)).toEqual(['b', 'c']);
    await expect(store.rename('c1', scope, 'c', 'b')).rejects.toThrow(/already exists/u);
    await expect(store.rename('c1', scope, 'c', 'x/y')).rejects.toThrow();
    expect(await store.list('c1', scope)).toEqual(['b', 'c']);
  });

  it('renames to the same name without complaint', async () => {
    await store.create('c1', scope, 'a');
    await store.rename('c1', scope, 'a', 'a');
    expect(await store.list('c1', scope)).toEqual(['a']);
  });

  it('removes a query, and a missing one is not an error', async () => {
    await store.create('c1', scope, 'a');
    await store.remove('c1', scope, 'a');
    await store.remove('c1', scope, 'a');
    expect(await store.list('c1', scope)).toEqual([]);
    expect(await readdir(store.folderOf('c1', scope))).toEqual([]);
  });
});
