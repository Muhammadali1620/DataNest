import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { MetadataReader } from '../../../src/drivers/driver';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { FakeMetadata } from '../../helpers/fake-driver';
import { RecordingLogger } from '../../helpers/fakes';

function reader(): FakeMetadata {
  return new FakeMetadata();
}

describe('MetadataCache', () => {
  let cache: MetadataCache;

  beforeEach(() => {
    cache = new MetadataCache({ logger: new RecordingLogger() });
  });

  describe('caching', () => {
    it('asks the server once and answers the rest from memory', async () => {
      const inner = reader();
      const wrapped = cache.wrap('c1', inner);
      expect(await wrapped.listDatabases()).toEqual(['main']);
      expect(await wrapped.listDatabases()).toEqual(['main']);
      expect(inner.calls).toEqual(['listDatabases']);
    });

    it('caches every reader separately by its arguments', async () => {
      const inner = reader();
      const wrapped = cache.wrap('c1', inner);
      await wrapped.listTables({ database: 'app' });
      await wrapped.listTables({ database: 'app' });
      await wrapped.listTables({ database: 'shop' });
      await wrapped.listColumns({ database: 'app', name: 'orders' });
      await wrapped.listColumns({ database: 'app', name: 'orders' });
      await wrapped.listColumns({ database: 'app', name: 'customers' });
      await wrapped.listSchemas('app');
      await wrapped.listSchemas('app');
      expect(inner.calls).toEqual([
        'listTables:app/',
        'listTables:shop/',
        'listColumns:orders',
        'listColumns:customers',
        'listSchemas:app',
      ]);
    });

    it('caches foreign keys per table and drops them with the rest', async () => {
      const inner = reader();
      const wrapped = cache.wrap('c1', inner);
      await wrapped.listForeignKeys({ database: 'app', name: 'orders' });
      await wrapped.listForeignKeys({ database: 'app', name: 'orders' });
      await wrapped.listForeignKeys({ database: 'app', name: 'items' });
      expect(inner.calls).toEqual(['listForeignKeys:orders', 'listForeignKeys:items']);
      cache.invalidate('c1');
      await wrapped.listForeignKeys({ database: 'app', name: 'orders' });
      expect(inner.calls).toHaveLength(3);
    });

    it('caches objects per scope and kind, and indexes per table', async () => {
      const inner = reader();
      const wrapped = cache.wrap('c1', inner);
      await wrapped.listObjects({ database: 'app' }, 'function');
      await wrapped.listObjects({ database: 'app' }, 'function');
      await wrapped.listObjects({ database: 'app' }, 'procedure');
      await wrapped.listObjects({ database: 'shop' }, 'function');
      await wrapped.listIndexes({ database: 'app', name: 'orders' });
      await wrapped.listIndexes({ database: 'app', name: 'orders' });
      await wrapped.listIndexes({ database: 'shop', name: 'orders' });
      expect(inner.calls).toEqual([
        'listObjects:app/:function',
        'listObjects:app/:procedure',
        'listObjects:shop/:function',
        'listIndexes:orders',
        'listIndexes:orders',
      ]);
    });

    it('caches the structure of a table until something drops the cache', async () => {
      const inner = reader();
      inner.structure = { columns: [], primaryKey: [], indexes: [], foreignKeys: [] };
      const wrapped = cache.wrap('c1', inner);
      await wrapped.describeTable({ database: 'app', name: 'orders' });
      await wrapped.describeTable({ database: 'app', name: 'orders' });
      expect(inner.calls).toEqual(['describeTable:orders']);
      cache.noteStatement('c1', 'ALTER TABLE orders ADD x int');
      await wrapped.describeTable({ database: 'app', name: 'orders' });
      expect(inner.calls).toEqual(['describeTable:orders', 'describeTable:orders']);
    });

    it('never caches definitions: the user wants the current one', async () => {
      const inner = reader();
      inner.definitions.set('view:v', ['CREATE VIEW v AS SELECT 1']);
      const wrapped = cache.wrap('c1', inner);
      await wrapped.getDefinition({ kind: 'view', name: 'v' });
      inner.definitions.set('view:v', ['CREATE VIEW v AS SELECT 2']);
      expect(await wrapped.getDefinition({ kind: 'view', name: 'v' })).toEqual([
        'CREATE VIEW v AS SELECT 2',
      ]);
      expect(inner.calls).toEqual(['getDefinition:view:v', 'getDefinition:view:v']);
    });

    it('never caches what a dump reads: it reads inside its own snapshot', async () => {
      const inner = reader();
      inner.tableDumps.set('t', { before: [], create: ['CREATE TABLE t'], after: [], owns: [] });
      const wrapped = cache.wrap('c1', inner);
      await wrapped.getTableDump({ name: 't' });
      await wrapped.getTableDump({ name: 't' });
      await wrapped.listTypeDumps({ schema: 's' }, ['t']);
      await wrapped.listTypeDumps({ schema: 's' }, ['t']);
      expect(inner.calls).toEqual([
        'getTableDump:t',
        'getTableDump:t',
        'listTypeDumps:/s:t',
        'listTypeDumps:/s:t',
      ]);
    });

    it('caches table statistics per scope, and has none where the reader has none', async () => {
      const inner = reader();
      expect(cache.wrap('c1', inner).tableStats === undefined).toBe(true);
      let reads = 0;
      inner.tableStats = (scope) => {
        reads++;
        return Promise.resolve([{ name: scope.schema ?? 'none', rows: reads }]);
      };
      const wrapped = cache.wrap('c1', inner);
      expect(await wrapped.tableStats?.({ schema: 'a' })).toEqual([{ name: 'a', rows: 1 }]);
      expect(await wrapped.tableStats?.({ schema: 'a' })).toEqual([{ name: 'a', rows: 1 }]);
      expect(await wrapped.tableStats?.({ schema: 'b' })).toEqual([{ name: 'b', rows: 2 }]);
      cache.invalidate('c1');
      expect(await wrapped.tableStats?.({ schema: 'a' })).toEqual([{ name: 'a', rows: 3 }]);
    });

    it('tells scopes apart even when a name contains the separator', async () => {
      const inner = reader();
      const wrapped = cache.wrap('c1', inner);
      await wrapped.listTables({ database: 'a', schema: 'b' });
      await wrapped.listTables({ database: 'a/b' });
      expect(inner.calls).toHaveLength(2);
    });

    it('keeps connections apart', async () => {
      const first = reader();
      const second = reader();
      await cache.wrap('c1', first).listDatabases();
      await cache.wrap('c2', second).listDatabases();
      expect(first.calls).toEqual(['listDatabases']);
      expect(second.calls).toEqual(['listDatabases']);
    });

    it('shares one request between callers that ask at the same time', async () => {
      let resolveCall: ((value: string[]) => void) | undefined;
      const inner: MetadataReader = {
        listDatabases: () =>
          new Promise((resolve) => {
            resolveCall = resolve;
          }),
        listSchemas: () => Promise.resolve([]),
        listTables: () => Promise.resolve([]),
        listColumns: () => Promise.resolve([]),
        listUniqueKeys: () => Promise.resolve([]),
        listForeignKeys: () => Promise.resolve([]),
        listObjects: () => Promise.resolve([]),
        listIndexes: () => Promise.resolve([]),
        describeTable: () => Promise.reject(new Error('no table')),
        getDefinition: () => Promise.resolve([]),
        getTableDump: () => Promise.resolve({ before: [], create: [], after: [], owns: [] }),
        listTypeDumps: () => Promise.resolve([]),
      };
      const load = vi.spyOn(inner, 'listDatabases');
      const wrapped = cache.wrap('c1', inner);
      const both = Promise.all([wrapped.listDatabases(), wrapped.listDatabases()]);
      resolveCall?.(['main']);
      expect(await both).toEqual([['main'], ['main']]);
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('serves a later wrapper of the same connection from the same cache', async () => {
      const first = reader();
      await cache.wrap('c1', first).listDatabases();
      const second = reader();
      // A reconnect hands out a new session, but the structure is still the same.
      expect(await cache.wrap('c1', second).listDatabases()).toEqual(['main']);
      expect(second.calls).toEqual([]);
    });
  });

  describe('failures', () => {
    it('does not cache a failure, so the next call reaches the server', async () => {
      const inner = reader();
      inner.error = new DbError('connection-failed', 'Connection lost');
      const wrapped = cache.wrap('c1', inner);
      await expect(wrapped.listDatabases()).rejects.toMatchObject({ code: 'connection-failed' });
      inner.error = undefined;
      expect(await wrapped.listDatabases()).toEqual(['main']);
      expect(inner.calls).toEqual(['listDatabases', 'listDatabases']);
    });

    it('leaves nothing behind after a failure', async () => {
      const inner = reader();
      inner.error = new DbError('timeout', 'too slow');
      await expect(cache.wrap('c1', inner).listDatabases()).rejects.toThrow('too slow');
      expect(cache.size).toBe(0);
    });

    it('keeps other cached reads of the same connection after one fails', async () => {
      const inner = reader();
      const wrapped = cache.wrap('c1', inner);
      await wrapped.listDatabases();
      inner.error = new DbError('not-found', 'no such table');
      await expect(wrapped.listColumns({ name: 'gone' })).rejects.toThrow('no such table');
      inner.error = undefined;
      await wrapped.listDatabases();
      expect(inner.calls.filter((call) => call === 'listDatabases')).toHaveLength(1);
    });
  });

  describe('invalidate', () => {
    it('makes the next read go to the server again', async () => {
      const inner = reader();
      const wrapped = cache.wrap('c1', inner);
      await wrapped.listDatabases();
      cache.invalidate('c1');
      await wrapped.listDatabases();
      expect(inner.calls).toEqual(['listDatabases', 'listDatabases']);
    });

    it('touches only the connection it is given', async () => {
      const first = reader();
      const second = reader();
      const a = cache.wrap('c1', first);
      const b = cache.wrap('c2', second);
      await a.listDatabases();
      await b.listDatabases();
      cache.invalidate('c1');
      await a.listDatabases();
      await b.listDatabases();
      expect(first.calls).toHaveLength(2);
      expect(second.calls).toHaveLength(1);
    });

    it('without an id drops everything', async () => {
      const first = reader();
      const second = reader();
      await cache.wrap('c1', first).listDatabases();
      await cache.wrap('c2', second).listDatabases();
      cache.invalidate();
      expect(cache.size).toBe(0);
      await cache.wrap('c1', first).listDatabases();
      expect(first.calls).toHaveLength(2);
    });

    it('is a no-op for a connection that cached nothing', () => {
      expect(() => {
        cache.invalidate('never-used');
      }).not.toThrow();
    });
  });

  describe('noteStatement', () => {
    it('drops the cache after a statement that changes structure', async () => {
      const inner = reader();
      const wrapped = cache.wrap('c1', inner);
      await wrapped.listTables({});
      cache.noteStatement('c1', 'CREATE TABLE t (a int)');
      await wrapped.listTables({});
      expect(inner.calls).toHaveLength(2);
    });

    it('keeps the cache after a plain query', async () => {
      const inner = reader();
      const wrapped = cache.wrap('c1', inner);
      await wrapped.listTables({});
      cache.noteStatement('c1', 'SELECT * FROM t');
      cache.noteStatement('c1', 'UPDATE t SET a = 1');
      await wrapped.listTables({});
      expect(inner.calls).toHaveLength(1);
    });

    it('does not touch another connection', async () => {
      const other = reader();
      const wrapped = cache.wrap('c2', other);
      await wrapped.listTables({});
      cache.noteStatement('c1', 'DROP TABLE t');
      await wrapped.listTables({});
      expect(other.calls).toHaveLength(1);
    });
  });
});
