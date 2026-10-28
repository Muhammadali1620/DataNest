import { describe, expect, it } from 'vitest';
import type { ColumnDesign, TableDesign } from '../../../src/shared/table-design';
import { diffTables, isEmptyDiff } from '../../../src/shared/table-diff';

function col(id: string, overrides: Partial<ColumnDesign> = {}): ColumnDesign {
  return {
    id,
    original: id,
    name: id,
    type: 'int',
    length: '',
    nullable: true,
    defaultValue: '',
    autoIncrement: false,
    primaryKey: false,
    comment: '',
    ...overrides,
  };
}

const BEFORE: TableDesign = {
  name: 'orders',
  comment: 'c',
  columns: [col('a', { primaryKey: true, nullable: false }), col('b'), col('c')],
  indexes: [{ id: 'i1', original: 'ix_b', name: 'ix_b', columns: ['b'], unique: false }],
  foreignKeys: [
    {
      id: 'k1',
      original: 'fk_c',
      name: 'fk_c',
      columns: ['c'],
      targetTable: 'parents',
      targetColumns: ['id'],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
    },
  ],
};

function change(patch: (design: TableDesign) => TableDesign) {
  return diffTables(BEFORE, patch(BEFORE));
}

describe('diffTables', () => {
  it('finds nothing in an unchanged table', () => {
    const diff = diffTables(BEFORE, structuredClone(BEFORE));
    expect(isEmptyDiff(diff)).toBe(true);
  });

  it('treats type spelling, case and spaces as no change', () => {
    const before = { ...BEFORE, columns: [col('a', { type: 'VARCHAR', length: '10, 2' })] };
    const after = { ...BEFORE, columns: [col('a', { type: 'varchar', length: '10,2' })] };
    expect(diffTables(before, after).changed).toEqual([]);
  });

  it('tells a renamed column from a dropped and added one', () => {
    const diff = change((d) => ({
      ...d,
      columns: d.columns.map((c) => (c.id === 'b' ? { ...c, name: 'bb' } : c)),
    }));
    expect(diff.dropped).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([
      expect.objectContaining({ renamed: true, type: false, nullable: false }),
    ]);
  });

  it('records each kind of column change', () => {
    const diff = change((d) => ({
      ...d,
      columns: d.columns.map((c) =>
        c.id === 'b'
          ? {
              ...c,
              type: 'bigint',
              nullable: false,
              defaultValue: '0',
              autoIncrement: true,
              comment: 'x',
            }
          : c,
      ),
    }));
    expect(diff.changed[0]).toMatchObject({
      renamed: false,
      type: true,
      nullable: true,
      defaultValue: true,
      autoIncrement: true,
      comment: true,
    });
  });

  it('lists dropped and added columns', () => {
    const diff = change((d) => ({
      ...d,
      columns: [...d.columns.filter((c) => c.id !== 'b'), col('new-1', { original: undefined })],
    }));
    expect(diff.dropped.map((c) => c.id)).toEqual(['b']);
    expect(diff.added.map((c) => c.id)).toEqual(['new-1']);
    expect(diff.order).toBe(false);
  });

  it('notices a new column that is not at the end, and moved columns', () => {
    const fresh = col('new-1', { original: undefined });
    expect(change((d) => ({ ...d, columns: [fresh, ...d.columns] })).order).toBe(true);
    expect(change((d) => ({ ...d, columns: [...d.columns].reverse() })).order).toBe(true);
  });

  it('notices a changed primary key, by members and by order', () => {
    expect(
      change((d) => ({
        ...d,
        columns: d.columns.map((c) => (c.id === 'b' ? { ...c, primaryKey: true } : c)),
      })).primaryKey,
    ).toBe(true);
    const twoKeys = {
      ...BEFORE,
      columns: [col('a', { primaryKey: true }), col('b', { primaryKey: true })],
    };
    const swapped = { ...twoKeys, columns: [...twoKeys.columns].reverse() };
    expect(diffTables(twoKeys, swapped).primaryKey).toBe(true);
  });

  it('drops and adds an index that changed, and keeps one that did not', () => {
    const renamedColumn = change((d) => ({
      ...d,
      columns: d.columns.map((c) => (c.id === 'b' ? { ...c, name: 'bb' } : c)),
    }));
    // The index follows the column by id: renaming the column leaves it alone.
    expect(renamedColumn.droppedIndexes).toEqual([]);
    const unique = change((d) => ({
      ...d,
      indexes: d.indexes.map((i) => ({ ...i, unique: true })),
    }));
    expect(unique.droppedIndexes.map((i) => i.unique)).toEqual([false]);
    expect(unique.addedIndexes.map((i) => i.unique)).toEqual([true]);
    const added = change((d) => ({
      ...d,
      indexes: [...d.indexes, { id: 'index-9', name: 'ix_c', columns: ['c'], unique: false }],
    }));
    expect(added.droppedIndexes).toEqual([]);
    expect(added.addedIndexes.map((i) => i.name)).toEqual(['ix_c']);
  });

  it('drops and adds a key whose action, target or columns changed', () => {
    for (const patch of [
      { onDelete: 'CASCADE' as const },
      { targetTable: 'others' },
      { targetColumns: ['code'] },
      { targetSchema: 'crm' },
      { name: 'fk_other' },
    ]) {
      const diff = change((d) => ({
        ...d,
        foreignKeys: d.foreignKeys.map((k) => ({ ...k, ...patch })),
      }));
      expect(diff.droppedKeys).toHaveLength(1);
      expect(diff.addedKeys).toHaveLength(1);
    }
    const removed = change((d) => ({ ...d, foreignKeys: [] }));
    expect(removed.droppedKeys).toHaveLength(1);
    expect(removed.addedKeys).toEqual([]);
  });

  it('notices a new table name and comment', () => {
    const diff = change((d) => ({ ...d, name: ' purchases ', comment: '' }));
    expect(diff.renamed).toBe(true);
    expect(diff.comment).toBe(true);
    expect(isEmptyDiff(diff)).toBe(false);
    expect(change((d) => ({ ...d, name: ' orders ' })).renamed).toBe(false);
  });
});
