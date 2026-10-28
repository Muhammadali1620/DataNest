import { describe, expect, it } from 'vitest';
import { newTableDesign, type TableDesign } from '../../../../../src/shared/table-design';
import {
  addColumn,
  addForeignKey,
  addIndex,
  columnProblems,
  indexProblems,
  keyProblems,
  moveColumn,
  nextColumnId,
  problemMessage,
  removeColumn,
  removeForeignKey,
  removeIndex,
  updateColumn,
  updateForeignKey,
  updateIndex,
} from '../../../../../webview/src/apps/table-designer/design-model';

function three(): TableDesign {
  let design = newTableDesign('mysql', 't');
  design = addColumn(design, 'mysql');
  design = addColumn(design, 'mysql');
  return design;
}

describe('addColumn', () => {
  it('adds a nullable varchar(255) in MySQL and text elsewhere', () => {
    const mysql = addColumn(newTableDesign('mysql'), 'mysql').columns[1];
    expect(mysql).toMatchObject({
      id: 'new-2',
      name: '',
      type: 'varchar',
      length: '255',
      nullable: true,
    });
    const pg = addColumn(newTableDesign('postgres'), 'postgres').columns[1];
    expect(pg).toMatchObject({ type: 'text', length: '' });
  });

  it('never reuses an id, even after removing columns', () => {
    let design = three();
    design = removeColumn(design, 'new-2');
    expect(nextColumnId(design)).toBe('new-4');
    expect(nextColumnId({ name: '', comment: '', columns: [], indexes: [], foreignKeys: [] })).toBe(
      'new-1',
    );
  });
});

describe('moveColumn', () => {
  it('moves a column up and down', () => {
    const design = three();
    expect(moveColumn(design, 'new-3', -1).columns.map((c) => c.id)).toEqual([
      'new-1',
      'new-3',
      'new-2',
    ]);
    expect(moveColumn(design, 'new-1', 1).columns.map((c) => c.id)).toEqual([
      'new-2',
      'new-1',
      'new-3',
    ]);
  });

  it('does nothing past either end or for an unknown column', () => {
    const design = three();
    expect(moveColumn(design, 'new-1', -1)).toBe(design);
    expect(moveColumn(design, 'new-3', 1)).toBe(design);
    expect(moveColumn(design, 'nope', 1)).toBe(design);
  });
});

describe('updateColumn', () => {
  it('changes only the column it is given', () => {
    const design = three();
    const next = updateColumn(design, 'new-2', { name: 'email' }, 'mysql');
    expect(next.columns[1]?.name).toBe('email');
    expect(next.columns[0]).toBe(design.columns[0]);
    expect(design.columns[1]?.name).toBe('');
  });

  it('makes a key column NOT NULL', () => {
    const next = updateColumn(three(), 'new-2', { primaryKey: true }, 'postgres');
    expect(next.columns[1]).toMatchObject({ primaryKey: true, nullable: false });
  });

  it('makes an auto-numbered column a NOT NULL key, except in PostgreSQL', () => {
    const mysql = updateColumn(three(), 'new-2', { autoIncrement: true }, 'mysql');
    expect(mysql.columns[1]).toMatchObject({ primaryKey: true, nullable: false });
    const pg = updateColumn(three(), 'new-2', { autoIncrement: true }, 'postgres');
    expect(pg.columns[1]).toMatchObject({ primaryKey: false, nullable: false });
  });

  it('keeps a key column NOT NULL when someone tries to make it nullable', () => {
    const keyed = updateColumn(three(), 'new-1', { nullable: true }, 'mysql');
    expect(keyed.columns[0]?.nullable).toBe(false);
  });
});

describe('problems', () => {
  it('has a message for every problem', () => {
    expect(problemMessage({ kind: 'table-name' })).toBe('designer.problem.tableName');
    expect(problemMessage({ kind: 'no-columns' })).toBe('designer.problem.noColumns');
    expect(problemMessage({ kind: 'column-name', column: 'a' })).toBe(
      'designer.problem.columnName',
    );
    expect(problemMessage({ kind: 'duplicate-column', column: 'a' })).toBe(
      'designer.problem.duplicateColumn',
    );
    expect(problemMessage({ kind: 'column-type', column: 'a' })).toBe(
      'designer.problem.columnType',
    );
    for (const [reason, key] of [
      ['type', 'designer.problem.autoType'],
      ['key', 'designer.problem.autoKey'],
      ['several', 'designer.problem.autoSeveral'],
      ['default', 'designer.problem.autoDefault'],
    ] as const) {
      expect(problemMessage({ kind: 'auto-increment', column: 'a', reason })).toBe(key);
    }
  });

  it('picks the problems of one column', () => {
    const problems = [
      { kind: 'table-name' } as const,
      { kind: 'column-name', column: 'a' } as const,
      { kind: 'column-type', column: 'b' } as const,
    ];
    expect(columnProblems(problems, 'b')).toEqual([{ kind: 'column-type', column: 'b' }]);
    expect(columnProblems(problems, 'z')).toEqual([]);
  });
});

describe('indexes', () => {
  it('names a new index after the table and never repeats a name or id', () => {
    let design = addIndex(three());
    design = addIndex(design);
    expect(design.indexes.map((index) => [index.id, index.name])).toEqual([
      ['index-1', 'ix_t_1'],
      ['index-2', 'ix_t_2'],
    ]);
    design = removeIndex(design, 'index-1');
    design = addIndex(design);
    expect(design.indexes.map((index) => index.id)).toEqual(['index-2', 'index-3']);
    expect(addIndex({ ...three(), name: ' my table ' }).indexes[0]?.name).toBe('ix_my_table_1');
    expect(addIndex({ ...three(), name: '' }).indexes[0]?.name).toBe('ix_table_1');
  });

  it('updates one index', () => {
    const design = updateIndex(addIndex(three()), 'index-1', { columns: ['new-2'], unique: true });
    expect(design.indexes[0]).toMatchObject({ columns: ['new-2'], unique: true });
  });
});

describe('foreign keys', () => {
  it('adds a key with default actions', () => {
    expect(addForeignKey(three()).foreignKeys[0]).toEqual({
      id: 'key-1',
      name: 'fk_t_1',
      columns: [],
      targetTable: '',
      targetColumns: [],
      onDelete: 'NO ACTION',
      onUpdate: 'NO ACTION',
    });
  });

  it('empties the referenced columns when the referenced table changes', () => {
    let design = updateForeignKey(addForeignKey(three()), 'key-1', {
      targetTable: 'a',
      targetColumns: ['id'],
    });
    expect(design.foreignKeys[0]?.targetColumns).toEqual(['id']);
    design = updateForeignKey(design, 'key-1', { targetTable: 'a', onDelete: 'CASCADE' });
    expect(design.foreignKeys[0]).toMatchObject({ targetColumns: ['id'], onDelete: 'CASCADE' });
    design = updateForeignKey(design, 'key-1', { targetTable: 'b' });
    expect(design.foreignKeys[0]?.targetColumns).toEqual([]);
  });

  it('removes a key', () => {
    expect(removeForeignKey(addForeignKey(three()), 'key-1').foreignKeys).toEqual([]);
  });
});

describe('removing a column used by indexes and keys', () => {
  it('takes it out of indexes and drops the paired referenced column of a key', () => {
    let design = updateIndex(addIndex(three()), 'index-1', { columns: ['new-1', 'new-2'] });
    design = updateForeignKey(addForeignKey(design), 'key-1', {
      columns: ['new-2', 'new-3'],
      targetTable: 'p',
      targetColumns: ['x', 'y'],
    });
    design = removeColumn(design, 'new-2');
    expect(design.indexes[0]?.columns).toEqual(['new-1']);
    expect(design.foreignKeys[0]).toMatchObject({ columns: ['new-3'], targetColumns: ['y'] });
  });
});

describe('problems of indexes and keys', () => {
  it('has a message for each and picks them by id', () => {
    const problems = [
      { kind: 'index-name', index: 'i' } as const,
      { kind: 'duplicate-key', key: 'k' } as const,
      { kind: 'key-target', key: 'k' } as const,
    ];
    expect(indexProblems(problems, 'i')).toHaveLength(1);
    expect(keyProblems(problems, 'k')).toHaveLength(2);
    expect(problemMessage({ kind: 'index-name', index: 'i' })).toBe('designer.problem.indexName');
    expect(problemMessage({ kind: 'key-name', key: 'k' })).toBe('designer.problem.indexName');
    expect(problemMessage({ kind: 'duplicate-index', index: 'i' })).toBe(
      'designer.problem.duplicateIndex',
    );
    expect(problemMessage({ kind: 'key-columns', key: 'k' })).toBe('designer.problem.indexColumns');
    expect(problemMessage({ kind: 'key-target', key: 'k' })).toBe('designer.problem.keyTarget');
    expect(problemMessage({ kind: 'key-target-columns', key: 'k' })).toBe(
      'designer.problem.keyTargetColumns',
    );
  });
});
