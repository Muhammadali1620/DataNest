import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { compareSchemas } from '../../../../src/services/schema-compare/compare';
import { itemStatements, migrationScript } from '../../../../src/services/schema-compare/migration';
import { snapshot, structure } from '../../../helpers/schema-snapshots';

const fk = (name: string, column: string, table: string) => ({
  name,
  columns: [column],
  target: { schema: 'src', name: table },
  targetColumns: ['id'],
});

const source = snapshot(
  { schema: 'src' },
  {
    a: structure(['id int*', 'b_id int?'], { foreignKeys: [fk('fk_a_b', 'b_id', 'b')] }),
    b: structure(['id int*', 'name varchar(50)']),
    kept: structure(['id int*', 'n bigint']),
  },
  [
    {
      ref: { kind: 'view', name: 'v2' },
      statements: ['CREATE VIEW src.v2 AS SELECT * FROM src.v1'],
    },
    {
      ref: { kind: 'view', name: 'v1' },
      statements: ['CREATE VIEW src.v1 AS SELECT * FROM src.a'],
    },
    {
      ref: { kind: 'function', name: 'f' },
      statements: ['CREATE FUNCTION src.f() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql'],
    },
    {
      ref: { kind: 'trigger', name: 'tr', table: 'kept' },
      statements: [
        'CREATE TRIGGER tr AFTER INSERT ON src.kept FOR EACH ROW EXECUTE FUNCTION src.f()',
      ],
    },
    { ref: { kind: 'sequence', name: 's' }, statements: ['CREATE SEQUENCE src.s START 5'] },
  ],
);
const target = snapshot(
  { schema: 'dst' },
  {
    kept: structure(['id int*', 'n int']),
    old_child: structure(['id int*', 'p int'], {
      foreignKeys: [
        { ...fk('fk_old', 'p', 'old_parent'), target: { schema: 'dst', name: 'old_parent' } },
      ],
    }),
    old_parent: structure(['id int*']),
  },
  [
    { ref: { kind: 'view', name: 'v1' }, statements: ['CREATE VIEW dst.v1 AS SELECT 1'] },
    {
      ref: { kind: 'function', name: 'f' },
      statements: ['CREATE FUNCTION dst.f() RETURNS int AS $$ SELECT 2 $$ LANGUAGE sql'],
    },
    { ref: { kind: 'sequence', name: 's' }, statements: ['CREATE SEQUENCE dst.s START 1'] },
    { ref: { kind: 'function', name: 'gone' }, statements: ['CREATE FUNCTION dst.gone()'] },
  ],
);
const quote = (name: string) => postgresDialect.quoteIdentifier(name);
const items = compareSchemas(source, target, { driver: 'postgres', quote });
const input = {
  dialect: postgresDialect,
  driver: 'postgres' as const,
  target: { schema: 'dst' },
  sourceLabel: 'Local · src',
  targetLabel: 'Local · dst',
  date: new Date('2026-10-30T00:00:00Z'),
};

describe('migrationScript', () => {
  const script = migrationScript({
    ...input,
    items: items.filter((item) => item.status !== 'same'),
  });
  const at = (text: string): number => {
    const index = script.indexOf(text);
    expect(index, text).toBeGreaterThanOrEqual(0);
    return index;
  };

  it('starts with what it is and when it was written', () => {
    expect(
      script.startsWith(
        '-- DataNest schema migration\n-- From (source): Local · src\n-- To (target):   Local · dst\n-- Written 2026-10-30T00:00:00.000Z',
      ),
    ).toBe(true);
  });

  it('creates new tables in the target schema, the referenced one first', () => {
    expect(at('CREATE TABLE "dst"."b"')).toBeLessThan(at('CREATE TABLE "dst"."a"'));
    expect(script).not.toContain('"src"');
  });

  it('alters a table that differs and drops tables only in the target, children first', () => {
    expect(script).toMatch(/ALTER TABLE "dst"\."kept" ALTER COLUMN "n" TYPE bigint/u);
    expect(at('DROP TABLE "dst"."old_child"')).toBeLessThan(at('DROP TABLE "dst"."old_parent"'));
  });

  it('drops changed views and functions before the tables change and creates them after', () => {
    expect(at('DROP VIEW "dst"."v1"')).toBeLessThan(at('-- New tables'));
    expect(at('DROP FUNCTION')).toBeLessThan(at('-- New tables'));
    expect(at('CREATE FUNCTION dst.f()')).toBeGreaterThan(at('-- Tables that differ'));
    // A view after the view it reads, and both after the tables.
    expect(at('CREATE VIEW dst.v1')).toBeLessThan(at('CREATE VIEW dst.v2'));
    expect(at('CREATE VIEW dst.v1')).toBeGreaterThan(at('CREATE TABLE "dst"."a"'));
    expect(at('CREATE TRIGGER tr')).toBeGreaterThan(at('CREATE FUNCTION dst.f()'));
  });

  it('only describes a sequence that differs, so its current value stays', () => {
    expect(script).toContain('-- s differs. In the source:\n-- CREATE SEQUENCE dst.s START 5\n');
    expect(script).not.toMatch(/DROP SEQUENCE[^\n]*"s"/u);
  });

  it('ends statements as a script runner expects', () => {
    expect(script).toContain('CREATE VIEW dst.v2 AS SELECT * FROM dst.v1;\n');
  });

  it('says so when there is nothing to change', () => {
    expect(migrationScript({ ...input, items: [] })).toContain('-- Nothing to change.');
  });
});

describe('itemStatements', () => {
  it('gives the part of the script one difference makes', () => {
    const view = items.find((item) => item.name === 'v1');
    if (view === undefined) {
      throw new Error('no v1');
    }
    expect(itemStatements(view, input).statements).toEqual([
      'DROP VIEW "dst"."v1"',
      'CREATE VIEW dst.v1 AS SELECT * FROM dst.a',
    ]);
  });

  it('notes what a created table lacks and a change the dialect refuses', () => {
    const generated = compareSchemas(
      snapshot({ database: 'x' }, { t: structure(['id int*', 'g int'], { generated: ['g'] }) }),
      snapshot({ database: 'y' }, {}),
      { driver: 'mysql', quote: (name) => mysqlDialect.quoteIdentifier(name) },
    );
    const part = itemStatements(generated[0] ?? (undefined as never), {
      ...input,
      dialect: mysqlDialect,
      driver: 'mysql',
      target: { database: 'y' },
    });
    expect(part.comments).toEqual(['t: generated column g is not created']);
    expect(part.statements[0]).toMatch(/^CREATE TABLE `y`\.`t`/u);
  });
});
