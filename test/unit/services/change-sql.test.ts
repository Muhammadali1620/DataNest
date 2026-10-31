import { describe, expect, it } from 'vitest';
import type { EditableColumn, EditableResult } from '../../../src/core/model/editability';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import { buildChangeStatements, type ChangePlan } from '../../../src/services/change-sql';
import type { CellChange } from '../../../src/services/pending-edits';
import { binaryValue } from '../../../src/drivers/common/values';

function column(name: string, extra: Partial<EditableColumn> = {}): EditableColumn {
  return { name, dataType: 'text', nullable: true, kind: 'text', ...extra };
}

const EDIT: EditableResult = {
  editable: true,
  table: { name: 'users' },
  columnMap: ['id', 'name', 'created', null],
  columns: [
    column('id', { dataType: 'int', kind: 'integer', nullable: false }),
    column('name'),
    column('created', { defaultValue: 'CURRENT_TIMESTAMP' }),
    null,
  ],
  keyColumns: ['id'],
  keyIndexes: [0],
};

const value = (
  v: CellChange extends infer C ? (C extends { value: infer V } ? V : never) : never,
): CellChange => ({
  kind: 'value',
  value: v,
});

function plan(overrides: Partial<ChangePlan> = {}): ChangePlan {
  return { edit: EDIT, updates: [], deletions: [], insertions: [], ...overrides };
}

describe('buildChangeStatements', () => {
  it('updates changed cells of a row found by its original key', () => {
    const statements = buildChangeStatements(
      plan({
        updates: [
          {
            row: [7, 'old', 'x', 1],
            cells: new Map([
              [1, value("O'Brien")],
              [0, value(8)],
            ]),
          },
        ],
      }),
      postgresDialect,
    );
    expect(statements).toEqual([
      {
        kind: 'update',
        sql: `UPDATE "users" SET "id" = 8, "name" = 'O''Brien' WHERE "id" = 7`,
        expectedRows: 1,
      },
    ]);
  });

  it('writes DEFAULT where the dialect has the keyword, and the schema default where not', () => {
    const cells = new Map<number, CellChange>([[2, { kind: 'default' }]]);
    const row = [1, 'a', 'x', null];
    expect(buildChangeStatements(plan({ updates: [{ row, cells }] }), mysqlDialect)[0]?.sql).toBe(
      'UPDATE `users` SET `created` = DEFAULT WHERE `id` = 1',
    );
    expect(buildChangeStatements(plan({ updates: [{ row, cells }] }), sqliteDialect)[0]?.sql).toBe(
      'UPDATE "users" SET "created" = CURRENT_TIMESTAMP WHERE "id" = 1',
    );
  });

  it('uses NULL for a default the schema does not state, on a dialect without the keyword', () => {
    const cells = new Map<number, CellChange>([[1, { kind: 'default' }]]);
    expect(
      buildChangeStatements(
        plan({ updates: [{ row: [1, 'a', 'x', null], cells }] }),
        sqliteDialect,
      )[0]?.sql,
    ).toBe('UPDATE "users" SET "name" = NULL WHERE "id" = 1');
  });

  it('matches a composite key with every column', () => {
    const edit: EditableResult = {
      ...EDIT,
      columnMap: ['a', 'b', 'v'],
      columns: [column('a'), column('b'), column('v')],
      keyColumns: ['a', 'b'],
      keyIndexes: [0, 1],
    };
    const [statement] = buildChangeStatements(
      { edit, updates: [], insertions: [], deletions: [['x', 2, 'val']] },
      mysqlDialect,
    );
    expect(statement?.sql).toBe("DELETE FROM `users` WHERE `a` = 'x' AND `b` = 2");
  });

  it('finds a row whose key is NULL with IS NULL, never "= NULL"', () => {
    const [statement] = buildChangeStatements(
      plan({ deletions: [[null, 'a', 'x', null]] }),
      postgresDialect,
    );
    expect(statement?.sql).toBe('DELETE FROM "users" WHERE "id" IS NULL');
  });

  it('deletes by key and expects exactly one row', () => {
    const [statement] = buildChangeStatements(
      plan({ deletions: [[3, 'a', 'x', null]] }),
      postgresDialect,
    );
    expect(statement).toEqual({
      kind: 'delete',
      sql: 'DELETE FROM "users" WHERE "id" = 3',
      expectedRows: 1,
    });
  });

  it('inserts only the cells the user filled in', () => {
    const [statement] = buildChangeStatements(
      plan({
        insertions: [
          new Map([
            [1, value('Zoe')],
            [0, value(9)],
          ]),
        ],
      }),
      postgresDialect,
    );
    expect(statement?.sql).toBe(`INSERT INTO "users" ("id", "name") VALUES (9, 'Zoe')`);
  });

  it('inserts a row of defaults when nothing was filled in', () => {
    expect(buildChangeStatements(plan({ insertions: [new Map()] }), mysqlDialect)[0]?.sql).toBe(
      'INSERT INTO `users` () VALUES ()',
    );
    expect(buildChangeStatements(plan({ insertions: [new Map()] }), sqliteDialect)[0]?.sql).toBe(
      'INSERT INTO "users" DEFAULT VALUES',
    );
  });

  it('can insert an explicit NULL and typed values through the dialect', () => {
    const [statement] = buildChangeStatements(
      plan({
        insertions: [
          new Map([
            [1, value(null)],
            [2, value({ kind: 'datetime', text: '2024-01-02 03:04:05' })],
          ]),
        ],
      }),
      mysqlDialect,
    );
    expect(statement?.sql).toBe(
      "INSERT INTO `users` (`name`, `created`) VALUES (NULL, '2024-01-02 03:04:05')",
    );
  });

  it('orders deletes before updates before inserts', () => {
    const kinds = buildChangeStatements(
      plan({
        insertions: [new Map()],
        updates: [{ row: [1, 'a', 'x', null], cells: new Map([[1, value('b')]]) }],
        deletions: [[2, 'a', 'x', null]],
      }),
      postgresDialect,
    ).map((statement) => statement.kind);
    expect(kinds).toEqual(['delete', 'update', 'insert']);
  });

  it('qualifies the table the way the dialect does', () => {
    const edit: EditableResult = { ...EDIT, table: { schema: 'inventory', name: 'users' } };
    const [statement] = buildChangeStatements(
      { edit, updates: [], insertions: [], deletions: [[1, 'a', 'x', null]] },
      postgresDialect,
    );
    expect(statement?.sql).toBe('DELETE FROM "inventory"."users" WHERE "id" = 1');
  });

  it('quotes awkward names', () => {
    const edit: EditableResult = {
      ...EDIT,
      table: { name: 'we"ird' },
      columns: [column('i"d', { kind: 'integer' }), null, null, null],
    };
    const [statement] = buildChangeStatements(
      { edit, updates: [], insertions: [], deletions: [[1, null, null, null]] },
      postgresDialect,
    );
    expect(statement?.sql).toBe('DELETE FROM "we""ird" WHERE "i""d" = 1');
  });

  it('skips a row with no cells to update and plans nothing for an empty plan', () => {
    expect(
      buildChangeStatements(
        plan({ updates: [{ row: [1, 'a', 'x', null], cells: new Map() }] }),
        postgresDialect,
      ),
    ).toEqual([]);
    expect(buildChangeStatements(plan(), postgresDialect)).toEqual([]);
  });

  it('refuses a change to a computed column', () => {
    expect(() =>
      buildChangeStatements(
        plan({ updates: [{ row: [1, 'a', 'x', 5], cells: new Map([[3, value(1)]]) }] }),
        postgresDialect,
      ),
    ).toThrow('not backed');
  });
});

describe('buildChangeStatements with values from files (V10.2.4)', () => {
  const photo: EditableResult = {
    ...EDIT,
    columnMap: ['id', 'photo'],
    columns: [
      column('id', { dataType: 'int', kind: 'integer', nullable: false }),
      column('photo', { dataType: 'bytea', kind: 'binary' }),
    ],
  };

  it('writes every byte of a loaded binary value, not just its preview', () => {
    const bytes = Uint8Array.from({ length: 400 }, (_, index) => index % 256);
    const [statement] = buildChangeStatements(
      plan({
        edit: photo,
        updates: [{ row: [1, null], cells: new Map([[1, value(binaryValue(bytes))]]) }],
      }),
      postgresDialect,
    );
    expect(statement?.sql).toContain(`'\\x${Buffer.from(bytes).toString('hex')}'::bytea`);
  });

  it('refuses a binary value whose bytes it does not have, rather than cut it', () => {
    expect(() =>
      buildChangeStatements(
        plan({
          edit: photo,
          updates: [
            {
              row: [1, null],
              cells: new Map([[1, value({ kind: 'binary', size: 9000, preview: 'ff' })]]),
            },
          ],
        }),
        postgresDialect,
      ),
    ).toThrow(/larger than DataNest can copy/u);
  });

  it('finds a row of a keyless table by all the values in its "key"', () => {
    const loose: EditableResult = {
      ...EDIT,
      columnMap: ['name', 'qty'],
      columns: [column('name'), column('qty', { dataType: 'int', kind: 'integer' })],
      keyColumns: ['name', 'qty'],
      keyIndexes: [0, 1],
      keyless: true,
    };
    const [removal, update] = buildChangeStatements(
      plan({
        edit: loose,
        updates: [{ row: ['pen', null], cells: new Map([[1, value(3)]]) }],
        deletions: [['cup', 2]],
      }),
      mysqlDialect,
    ).sort((a, b) => a.kind.localeCompare(b.kind));
    expect(removal?.sql).toBe("DELETE FROM `users` WHERE `name` = 'cup' AND `qty` = 2");
    expect(update?.sql).toBe("UPDATE `users` SET `qty` = 3 WHERE `name` = 'pen' AND `qty` IS NULL");
  });
});
