import { describe, expect, it } from 'vitest';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import type { DataCompareResult } from '../../../../src/services/data-compare/data-compare';
import {
  syncScript,
  type SyncScriptInput,
} from '../../../../src/services/data-compare/sync-script';

const result: DataCompareResult = {
  same: 10,
  different: 2,
  onlySource: 3,
  onlyTarget: 1,
  differentRows: [
    { source: [1, 'tea', 1, 'n'], target: [1, 'TEA', true, 'n'] },
    { source: [2, 'milk', 0, 'x'], target: [2, 'milk', false, 'x'] },
  ],
  onlySourceRows: [[7, "o'clock", 1, 'g']],
  onlyTargetRows: [[9, 'soda', false, null]],
  durationMs: 1,
};

const input = (overrides: Partial<SyncScriptInput> = {}): SyncScriptInput => ({
  dialect: postgresDialect,
  driver: 'postgres',
  table: { schema: 'public', name: 'items' },
  key: ['id'],
  columns: ['name', 'active', 'total'],
  types: [
    { kind: 'integer', bytes: 4, unsigned: false },
    { kind: 'text' },
    { kind: 'boolean' },
    { kind: 'text' },
  ],
  modes: ['plain', 'plain', 'plain', 'plain'],
  writable: new Set(['id', 'name', 'active']),
  identity: false,
  transactions: true,
  result,
  include: { insert: true, update: true, delete: true },
  sourceLabel: 'mysql · items',
  targetLabel: 'pg · items',
  date: new Date('2026-10-30T00:00:00Z'),
  ...overrides,
});

describe('syncScript', () => {
  const script = syncScript(input());

  it('starts with what it is and runs in a transaction', () => {
    expect(script.startsWith('-- DataNest data sync\n-- From (source): mysql · items\n')).toBe(
      true,
    );
    expect(script.indexOf('BEGIN;')).toBeLessThan(script.indexOf('INSERT'));
    expect(script.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('inserts the missing rows with values made to fit the target, without computed columns', () => {
    expect(script).toContain(
      `INSERT INTO "public"."items" ("id", "name", "active") VALUES\n(7, 'o''clock', TRUE);`,
    );
  });

  it('updates only the columns that differ, found by the target key', () => {
    expect(script).toContain(`UPDATE "public"."items" SET "name" = 'tea' WHERE "id" = 1;`);
    // 0 and false are the same flag: nothing to write for milk.
    expect(script).not.toContain('WHERE "id" = 2');
  });

  it('deletes the rows only in the target', () => {
    expect(script).toContain('DELETE FROM "public"."items" WHERE "id" = 9;');
  });

  it('writes only the parts asked for', () => {
    const inserts = syncScript(input({ include: { insert: true, update: false, delete: false } }));
    expect(inserts).toContain('INSERT');
    expect(inserts).not.toContain('UPDATE');
    expect(inserts).not.toContain('DELETE');
    const nothing = syncScript(input({ include: { insert: false, update: false, delete: false } }));
    expect(nothing).toContain('-- Nothing to change.');
    expect(nothing).not.toContain('BEGIN');
  });

  it('says when it holds only the first of many rows', () => {
    const big = syncScript(input({ result: { ...result, onlySource: 50_000 } }));
    expect(big).toContain('-- Only the first 1 of them; compare again after running this.');
  });

  it('matches a NULL key with IS NULL and skips the transaction where there is none', () => {
    const text = syncScript(
      input({
        dialect: sqliteDialect,
        driver: 'sqlite',
        table: { name: 'items' },
        transactions: false,
        result: { ...result, onlyTargetRows: [[null, 'x', 0, null]] },
        include: { insert: false, update: false, delete: true },
      }),
    );
    expect(text).toContain('DELETE FROM "items" WHERE "id" IS NULL;');
    expect(text).not.toContain('BEGIN');
  });
});
