import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import type { SchemaSnapshot } from '../../../../src/services/schema-compare/snapshot';
import {
  type CompareSide,
  SchemaCompareModel,
} from '../../../../src/vscode/panels/schema-compare-model';
import { snapshot, structure } from '../../../helpers/schema-snapshots';

const left = snapshot(
  { schema: 'src' },
  {
    t: structure(['id int*', 'name varchar(50)', 'email text?'], {
      indexes: [{ name: 'ix_name', columns: ['name'], unique: true, primary: false }],
      comment: 'new comment',
    }),
    added: structure(['id int*']),
  },
  [{ ref: { kind: 'view', name: 'v' }, statements: ['CREATE VIEW src.v AS\nSELECT 2'] }],
);
const right = snapshot(
  { schema: 'dst' },
  {
    t: structure(['id int*', 'name varchar(20)?', 'phone text?'], {
      indexes: [{ name: 'ix_name', columns: ['name'], unique: false, primary: false }],
      comment: 'old comment',
    }),
    gone: structure(['id int*']),
  },
  [{ ref: { kind: 'view', name: 'v' }, statements: ['CREATE VIEW dst.v AS\nSELECT 1'] }],
);

function side(
  label: string,
  scope: SchemaSnapshot['scope'],
  read: () => Promise<SchemaSnapshot>,
): CompareSide {
  return {
    connectionId: label,
    label,
    scope,
    read: async ({ onProgress }) => {
      onProgress?.(1, 2);
      return await read();
    },
  };
}

function model(readRight: () => Promise<SchemaSnapshot> = () => Promise.resolve(right)) {
  return new SchemaCompareModel({
    source: side('Local · src', { schema: 'src' }, () => Promise.resolve(left)),
    target: side('Local · dst', { schema: 'dst' }, readRight),
    dialect: postgresDialect,
    driver: 'postgres',
  });
}

describe('SchemaCompareModel', () => {
  it('reads both sides with progress and lists the differences', async () => {
    const instance = model();
    const seen: string[] = [];
    await instance.load({
      onProgress: (state) => seen.push(`${state.loading?.side}:${state.loading?.done}`),
    });
    expect(seen).toEqual(['source:0', 'source:1', 'target:0', 'target:1']);
    const state = instance.state();
    expect(state.loading).toBeUndefined();
    expect(state.items.map((item) => [item.kind, item.name, item.status])).toEqual([
      ['table', 't', 'changed'],
      ['table', 'added', 'added'],
      ['table', 'gone', 'removed'],
      ['view', 'v', 'changed'],
    ]);
    expect(instance.loaded).toBe(true);
  });

  it('shows column, key and comment changes of a table and its script', async () => {
    const instance = model();
    await instance.load();
    const detail = instance.detail('table:t');
    expect(detail.columns).toEqual([
      { name: 'email', change: 'added', after: 'text' },
      { name: 'phone', change: 'removed', before: 'text' },
      { name: 'name', change: 'changed', before: 'varchar(20)', after: 'varchar(50) NOT NULL' },
    ]);
    expect(detail.keys).toEqual([
      {
        kind: 'index',
        name: 'ix_name',
        change: 'changed',
        before: '(name)',
        after: 'UNIQUE (name)',
      },
    ]);
    expect(detail.comment).toEqual({ before: 'old comment', after: 'new comment' });
    expect(detail.script).toContain('ALTER TABLE "dst"."t"');
  });

  it('lists the columns of a table only on one side', async () => {
    const instance = model();
    await instance.load();
    expect(instance.detail('table:added').columns).toEqual([
      { name: 'id', change: 'added', after: 'int NOT NULL' },
    ]);
    expect(instance.detail('table:gone').columns).toEqual([
      { name: 'id', change: 'removed', before: 'int NOT NULL' },
    ]);
    expect(instance.detail('table:gone').script).toContain('DROP TABLE "dst"."gone"');
  });

  it('shows a view as a line diff from the target to the source', async () => {
    const instance = model();
    await instance.load();
    expect(instance.detail(instance.state().items[3]?.id ?? '').diff).toEqual([
      { op: 'same', text: 'CREATE VIEW dst.v AS' },
      { op: 'remove', text: 'SELECT 1' },
      { op: 'add', text: 'SELECT 2' },
    ]);
  });

  it('writes the script of the chosen differences only', async () => {
    const instance = model();
    await instance.load();
    const script = instance.script(['table:added', 'nope'], new Date(0));
    expect(script).toContain('CREATE TABLE "dst"."added"');
    expect(script).not.toContain('"gone"');
    expect(() => instance.detail('nope')).toThrow('no longer');
  });

  it('swaps the sides, and then the script changes the other schema', async () => {
    const instance = model();
    await instance.load();
    instance.swap();
    expect(instance.loaded).toBe(false);
    expect(instance.targetSide.label).toBe('Local · src');
    await instance.load();
    expect(instance.state().source).toBe('Local · dst');
    expect(instance.script(['table:gone'], new Date(0))).toContain('CREATE TABLE "src"."gone"');
  });

  it('keeps the error of a failed read, and passes a cancel on', async () => {
    const failing = model(() => Promise.reject(new Error('permission denied for schema dst')));
    await failing.load();
    expect(failing.state().error).toBe('permission denied for schema dst');
    expect(failing.state().items).toEqual([]);
    const cancelled = model(() => Promise.reject(new DbError('cancelled', 'stop')));
    await expect(cancelled.load()).rejects.toMatchObject({ code: 'cancelled' });
    const progress = vi.fn();
    await model().load({ onProgress: progress });
    expect(progress).toHaveBeenCalled();
  });
});
