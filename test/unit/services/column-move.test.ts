import { describe, expect, it } from 'vitest';
import type { TableStructure } from '../../../src/core/model/objects';
import { clickhouseDialect } from '../../../src/drivers/clickhouse/dialect';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import { planColumnMove } from '../../../src/services/column-move';
import { actionSql } from '../../../src/services/schema-actions';
import { canReorderColumns } from '../../../src/shared/table-design';
import { DRIVER_IDS } from '../../../src/shared/connection';
import { mssqlDialect } from '../../../src/drivers/mssql/dialect';
import { oracleDialect } from '../../../src/drivers/oracle/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';

const TABLE = { database: 'app', name: 'orders' };

function column(name: string, generated = false): TableStructure['columns'][number] {
  return { name, dataType: 'int', nullable: true, autoIncrement: false, generated };
}

const STRUCTURE: TableStructure = {
  columns: [column('id'), column('a'), column('b'), column('c')],
  primaryKey: [],
  indexes: [],
  foreignKeys: [],
};

describe('planColumnMove', () => {
  it('swaps a column with the one above it', () => {
    const action = planColumnMove(TABLE, STRUCTURE, 'b', 'up');
    expect(action?.after.columns.map((c) => c.name)).toEqual(['id', 'b', 'a', 'c']);
    expect(action?.before.columns.map((c) => c.name)).toEqual(['id', 'a', 'b', 'c']);
    expect(action?.table).toEqual(TABLE);
  });

  it('swaps a column with the one below it', () => {
    const action = planColumnMove(TABLE, STRUCTURE, 'a', 'down');
    expect(action?.after.columns.map((c) => c.name)).toEqual(['id', 'b', 'a', 'c']);
  });

  it('says nothing to do at the edges', () => {
    expect(planColumnMove(TABLE, STRUCTURE, 'id', 'up')).toBeUndefined();
    expect(planColumnMove(TABLE, STRUCTURE, 'c', 'down')).toBeUndefined();
  });

  it('refuses a column the designer does not hold (a generated one, a missing one)', () => {
    const generated: TableStructure = { ...STRUCTURE, columns: [column('id'), column('g', true)] };
    expect(() => planColumnMove(TABLE, generated, 'g', 'up')).toThrow(/cannot be moved/u);
    expect(() => planColumnMove(TABLE, STRUCTURE, 'nope', 'up')).toThrow(/cannot be moved/u);
  });

  it('becomes an ALTER that puts the displaced column AFTER its new neighbour on MySQL, or FIRST', () => {
    const down = planColumnMove(TABLE, STRUCTURE, 'a', 'down');
    const first = planColumnMove(TABLE, STRUCTURE, 'a', 'up');
    expect(down).toBeDefined();
    expect(first).toBeDefined();
    if (down === undefined || first === undefined) {
      return;
    }
    expect(actionSql(down, mysqlDialect.ddl).join('\n')).toContain(
      'CHANGE COLUMN `b` `b` int AFTER `id`',
    );
    expect(actionSql(first, mysqlDialect.ddl).join('\n')).toContain('FIRST');
  });

  it('becomes a statement on ClickHouse and a rebuild on SQLite', () => {
    const action = planColumnMove(TABLE, STRUCTURE, 'b', 'up');
    expect(action).toBeDefined();
    if (action === undefined) {
      return;
    }
    expect(actionSql(action, clickhouseDialect.ddl).join('\n')).toMatch(/AFTER|FIRST/u);
    expect(actionSql(action, sqliteDialect.ddl).length).toBeGreaterThan(1);
  });
});

describe('canReorderColumns', () => {
  const dialects = {
    mysql: mysqlDialect,
    postgres: postgresDialect,
    sqlite: sqliteDialect,
    mssql: mssqlDialect,
    clickhouse: clickhouseDialect,
    oracle: oracleDialect,
  } as const;

  it('agrees with what each driver reports to the table designer', () => {
    for (const [id, dialect] of Object.entries(dialects)) {
      expect(canReorderColumns(id as keyof typeof dialects), id).toBe(dialect.ddl.designer.reorder);
    }
  });

  it('is false for the drivers that have no SQL columns', () => {
    for (const id of DRIVER_IDS) {
      if (!(id in dialects)) {
        expect(canReorderColumns(id), id).toBe(false);
      }
    }
  });
});
