import { describe, expect, it } from 'vitest';
import { newTableDesign, type TableDesign } from '../../../../../src/shared/table-design';
import {
  addColumn,
  columnProblems,
  moveColumn,
  nextColumnId,
  problemMessage,
  removeColumn,
  updateColumn,
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
    expect(nextColumnId({ name: '', comment: '', columns: [] })).toBe('new-1');
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
