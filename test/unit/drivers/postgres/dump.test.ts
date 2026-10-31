import { describe, expect, it } from 'vitest';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { postgresDump } from '../../../../src/drivers/postgres/dump';

describe('postgresDump', () => {
  it('copies rows inside the database with INSERT … SELECT (V10.2.3)', () => {
    expect(postgresDump.insertSelect('"t"', ['"id"'], 'SELECT "id" FROM "s"', false)).toBe(
      'INSERT INTO "t" ("id")\nSELECT "id" FROM "s"',
    );
    expect(postgresDump.insertSelect('"t"', ['"id"'], 'SELECT "id" FROM "s"', true)).toBe(
      'INSERT INTO "t" ("id") OVERRIDING SYSTEM VALUE\nSELECT "id" FROM "s"',
    );
  });

  it('is the dump part of the PostgreSQL dialect', () => {
    expect(postgresDialect.dump).toBe(postgresDump);
  });

  it('reads with an empty search path in a repeatable-read snapshot', () => {
    expect(postgresDump.prepare.join()).toContain("set_config('search_path', '', false)");
    expect(postgresDump.beginSnapshot).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY']);
  });

  it('writes with the same path and resets what it changed', () => {
    expect(postgresDump.header).toContain('SET check_function_bodies = false');
    expect(postgresDump.header.join()).toContain("set_config('search_path', '', false)");
    expect(postgresDump.footer).toEqual([
      'RESET search_path',
      'RESET check_function_bodies',
      'RESET client_min_messages',
    ]);
    expect(postgresDump.routinesFirst).toBe(true);
  });

  it('overrides identity values only when there are identity columns', () => {
    expect(postgresDump.insert('"t"', ['"id"'], ['(1)'], true)).toBe(
      'INSERT INTO "t" ("id") OVERRIDING SYSTEM VALUE VALUES\n(1)',
    );
    expect(postgresDump.insert('"t"', ['"a"', '"b"'], ['(1, 2)', '(3, 4)'], false)).toBe(
      'INSERT INTO "t" ("a", "b") VALUES\n(1, 2),\n(3, 4)',
    );
  });

  it('moves the sequence of a column past its rows', () => {
    expect(postgresDump.resetSequence?.({ schema: 'sales', name: 'Orders' }, 'Id')).toBe(
      `SELECT pg_catalog.setval(pg_catalog.pg_get_serial_sequence('"sales"."Orders"', 'Id'), MAX("Id")) FROM "sales"."Orders" HAVING MAX("Id") IS NOT NULL`,
    );
  });

  it('quotes names inside the string it passes to pg_get_serial_sequence', () => {
    expect(postgresDump.resetSequence?.({ name: "it's" }, 'a"b')).toContain(
      `pg_get_serial_sequence('"it''s"', 'a"b')`,
    );
  });

  it('drops relations of one kind in one statement', () => {
    const tables = [
      { schema: 's', name: 'a' },
      { schema: 's', name: 'b' },
    ];
    expect(postgresDump.dropRelations(tables, 'table')).toEqual([
      'DROP TABLE IF EXISTS "s"."a", "s"."b"',
    ]);
    expect(postgresDump.dropRelations(tables.slice(0, 1), 'materialized-view')).toEqual([
      'DROP MATERIALIZED VIEW IF EXISTS "s"."a"',
    ]);
    expect(postgresDump.dropRelations([], 'view')).toEqual([]);
  });

  it('drops routines with their signature, and triggers on their table', () => {
    expect(
      postgresDump.dropObject({ kind: 'function', schema: 's', name: 'f', signature: 'integer' }),
    ).toBe('DROP FUNCTION IF EXISTS "s"."f"(integer)');
    expect(postgresDump.dropObject({ kind: 'procedure', name: 'p' })).toBe(
      'DROP PROCEDURE IF EXISTS "p"()',
    );
    expect(postgresDump.dropObject({ kind: 'sequence', schema: 's', name: 'q' })).toBe(
      'DROP SEQUENCE IF EXISTS "s"."q"',
    );
    expect(postgresDump.dropObject({ kind: 'trigger', schema: 's', name: 't', table: 'x' })).toBe(
      'DROP TRIGGER IF EXISTS "t" ON "s"."x"',
    );
    expect(postgresDump.dropObject({ kind: 'view', name: 'm', materialized: true })).toBe(
      'DROP MATERIALIZED VIEW IF EXISTS "m"',
    );
    expect(() => postgresDump.dropObject({ kind: 'trigger', name: 't' })).toThrow(/table/u);
    expect(() => postgresDump.dropObject({ kind: 'event', name: 'e' })).toThrow(/no scheduled/u);
  });

  it('creates the schema only when it is missing', () => {
    expect(postgresDump.createSchema?.('my "s"')).toBe('CREATE SCHEMA IF NOT EXISTS "my ""s"""');
  });
});
