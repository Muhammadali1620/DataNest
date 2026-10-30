import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { ObjectRef, TableRef } from '../../../../src/core/model/objects';
import { readSchemaSnapshot } from '../../../../src/services/schema-compare/snapshot';
import { FakeMetadata } from '../../../helpers/fake-driver';
import { structure } from '../../../helpers/schema-snapshots';

function metadata() {
  const fake = new FakeMetadata();
  fake.tables = [
    { name: 'orders', kind: 'table' },
    { name: 'totals', kind: 'view' },
    { name: 'stats', kind: 'view', materialized: true },
  ];
  fake.objects = [
    { name: 'f', kind: 'function', signature: 'integer' },
    { name: 'secret', kind: 'procedure' },
    { name: 'gone', kind: 'function' },
  ];
  fake.describeTable = (table: TableRef) =>
    Promise.resolve(structure([`id int*`, `${table.name}_name text?`]));
  fake.getDefinition = (object: ObjectRef) => {
    if (object.name === 'secret') {
      return Promise.reject(
        new DbError('permission-denied', 'The server does not show the definition'),
      );
    }
    if (object.name === 'gone') {
      return Promise.reject(new DbError('not-found', 'gone does not exist'));
    }
    return Promise.resolve([`CREATE ${object.kind} DEFINER=x ${object.name}`]);
  };
  return fake;
}

describe('readSchemaSnapshot', () => {
  it('reads tables as designs and the definitions of views and other objects', async () => {
    const progress: [number, number][] = [];
    const result = await readSchemaSnapshot(
      metadata(),
      { schema: 'public' },
      {
        kinds: ['function', 'procedure'],
        portable: (sql) => sql.replace(' DEFINER=x', ''),
        onProgress: (done, total) => progress.push([done, total]),
      },
    );
    expect(result.scope).toEqual({ schema: 'public' });
    expect(result.tables.map((table) => table.name)).toEqual(['orders']);
    expect(result.tables[0]?.loaded.design.columns.map((column) => column.name)).toEqual([
      'id',
      'orders_name',
    ]);
    expect(result.objects.map((object) => [object.ref.kind, object.ref.name])).toEqual([
      ['view', 'totals'],
      ['view', 'stats'],
      ['function', 'f'],
      ['procedure', 'secret'],
    ]);
    expect(result.objects[1]?.ref).toMatchObject({ materialized: true, schema: 'public' });
    expect(result.objects[2]).toMatchObject({
      ref: { signature: 'integer' },
      statements: ['CREATE function f'],
    });
    expect(result.objects[3]?.hidden).toBe('The server does not show the definition');
    expect(progress.at(-1)).toEqual([6, 6]);
  });

  it('asks only for the kinds the database has', async () => {
    const fake = metadata();
    await readSchemaSnapshot(fake, {}, { kinds: [] });
    expect(fake.calls.some((call) => call.startsWith('listObjects'))).toBe(false);
  });

  it('stops when cancelled and passes other errors on', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      readSchemaSnapshot(metadata(), {}, { kinds: [], signal: abort.signal }),
    ).rejects.toMatchObject({
      code: 'cancelled',
    });
    const failing = metadata();
    failing.getDefinition = () => Promise.reject(new Error('connection lost'));
    await expect(readSchemaSnapshot(failing, {}, { kinds: [] })).rejects.toThrow('connection lost');
  });
});
