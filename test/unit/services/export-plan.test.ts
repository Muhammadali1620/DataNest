import { describe, expect, it } from 'vitest';
import { planDatabaseExport } from '../../../src/services/export-plan';

describe('planDatabaseExport', () => {
  it('plans one file per table in the scope and leaves views out', () => {
    const plan = planDatabaseExport(
      { database: 'app', schema: 'public' },
      [
        { name: 'orders', kind: 'table' },
        { name: 'order_totals', kind: 'view' },
        { name: 'users', kind: 'table' },
      ],
      'csv',
    );
    expect(plan).toEqual([
      { table: { database: 'app', schema: 'public', name: 'orders' }, fileName: 'orders.csv' },
      { table: { database: 'app', schema: 'public', name: 'users' }, fileName: 'users.csv' },
    ]);
  });

  it('omits database and schema the scope does not have', () => {
    const [entry] = planDatabaseExport({}, [{ name: 't', kind: 'table' }], 'json');
    expect(entry?.table).toEqual({ name: 't' });
  });

  it('uses the extension of the format', () => {
    const names = (['csv', 'json', 'sql', 'markdown', 'xlsx'] as const).map(
      (format) => planDatabaseExport({}, [{ name: 't', kind: 'table' }], format)[0]?.fileName,
    );
    expect(names).toEqual(['t.csv', 't.json', 't.sql', 't.md', 't.xlsx']);
  });

  it('makes names safe for a file system but keeps the real table name', () => {
    const [entry] = planDatabaseExport({}, [{ name: 'a/b:c*?', kind: 'table' }], 'csv');
    expect(entry?.fileName).toBe('a_b_c_.csv');
    expect(entry?.table.name).toBe('a/b:c*?');
  });

  it('does not let a name start with dots or escape the folder', () => {
    const [entry] = planDatabaseExport({}, [{ name: '../secret', kind: 'table' }], 'csv');
    expect(entry?.fileName).not.toContain('/');
    expect(entry?.fileName.startsWith('.')).toBe(false);
  });

  it('keeps tables that differ only by case or by unsafe characters apart', () => {
    const plan = planDatabaseExport(
      {},
      [
        { name: 'Users', kind: 'table' },
        { name: 'users', kind: 'table' },
        { name: 'a/b', kind: 'table' },
        { name: 'a:b', kind: 'table' },
      ],
      'csv',
    );
    expect(plan.map((entry) => entry.fileName)).toEqual([
      'Users.csv',
      'users-2.csv',
      'a_b.csv',
      'a_b-2.csv',
    ]);
  });

  it('names an empty table name something and plans nothing for no tables', () => {
    expect(planDatabaseExport({}, [{ name: '', kind: 'table' }], 'csv')[0]?.fileName).toBe(
      'table.csv',
    );
    expect(planDatabaseExport({}, [], 'csv')).toEqual([]);
    expect(planDatabaseExport({}, [{ name: 'v', kind: 'view' }], 'csv')).toEqual([]);
  });
});
