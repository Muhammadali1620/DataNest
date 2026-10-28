import { beforeEach, describe, expect, it } from 'vitest';
import { ResultCopier } from '../../../src/services/result-copier';
import { ResultStore } from '../../../src/services/result-store';
import { MAX_COPY_ROWS } from '../../../src/shared/copy-format';
import type { CellValue } from '../../../src/shared/cell-value';
import { fakeDialect } from '../../helpers/fake-driver';

function setup() {
  const results = new ResultStore();
  const manager = { driverOf: () => Promise.resolve({ dialect: fakeDialect }) } as never;
  return { results, copier: new ResultCopier({ results, manager }) };
}

function add(results: ResultStore, rows: CellValue[][], extra: object = {}) {
  return results.add({
    documentUri: 'file:///q.sql',
    statement: 'SELECT * FROM t',
    statementStart: 0,
    columns: [{ name: 'id' }, { name: 'name' }],
    rows,
    truncated: false,
    durationMs: 1,
    origin: { target: { connectionId: 'c1' }, owner: 'o' },
    ...extra,
  });
}

describe('ResultCopier', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  it('copies the whole result when no rectangle is given', async () => {
    const { id } = add(ctx.results, [
      [1, 'a'],
      [2, 'b'],
    ]);
    const reply = await ctx.copier.render({ resultId: id, format: 'csv' });
    expect(reply).toEqual({ ok: true, text: 'id,name\r\n1,a\r\n2,b\r\n', rows: 2 });
  });

  it('copies only the rectangle, and clamps one that sticks out', async () => {
    const { id } = add(ctx.results, [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
    const reply = await ctx.copier.render({
      resultId: id,
      format: 'csv',
      top: 1,
      bottom: 99,
      columns: [1, 99, 1, -3],
    });
    expect(reply).toEqual({ ok: true, text: 'name\r\nb\r\nc\r\n', rows: 2 });
  });

  it('copies the columns it is given in that order, and drops ones that do not exist or repeat', async () => {
    const { id } = add(ctx.results, [[1, 'a']]);
    const reply = await ctx.copier.render({ resultId: id, format: 'csv', columns: [1, 0, 1, 7] });
    expect(reply).toEqual({ ok: true, text: 'name,id\r\na,1\r\n', rows: 1 });
  });

  it('has nothing to copy when none of the columns exists', async () => {
    const { id } = add(ctx.results, [[1, 'a']]);
    expect(await ctx.copier.render({ resultId: id, format: 'csv', columns: [8, -1] })).toEqual({
      ok: false,
      error: 'no-rows',
    });
    expect(await ctx.copier.render({ resultId: id, format: 'csv', columns: [] })).toEqual({
      ok: false,
      error: 'no-rows',
    });
  });

  it('swaps a reversed rectangle into order instead of failing', async () => {
    const { id } = add(ctx.results, [
      [1, 'a'],
      [2, 'b'],
    ]);
    const reply = await ctx.copier.render({ resultId: id, format: 'csv', top: 1, bottom: 0 });
    expect(reply.ok).toBe(true);
  });

  it('copies what the grid shows, including unsaved edits', async () => {
    const { id } = add(ctx.results, [[1, 'a']], {
      edit: {
        editable: true,
        table: { name: 't' },
        columnMap: ['id', 'name'],
        columns: [
          { name: 'id', dataType: 'int', nullable: false, kind: 'integer' },
          { name: 'name', dataType: 'text', nullable: true, kind: 'text' },
        ],
        keyColumns: ['id'],
        keyIndexes: [0],
      },
    });
    ctx.results.setChange(id, 0, 1, { kind: 'value', value: 'edited' });
    const reply = await ctx.copier.render({ resultId: id, format: 'tsv' });
    expect(reply).toMatchObject({ ok: true, text: 'id\tname\r\n1\tedited' });
  });

  it('knows nothing about an unknown result, an error, or an empty one', async () => {
    expect(await ctx.copier.render({ resultId: 'nope', format: 'csv' })).toEqual({
      ok: false,
      error: 'no-rows',
    });
    const failed = add(ctx.results, [], { columns: [], error: { code: 'syntax', message: 'x' } });
    expect(await ctx.copier.render({ resultId: failed.id, format: 'csv' })).toEqual({
      ok: false,
      error: 'no-rows',
    });
    const empty = add(ctx.results, []);
    expect(await ctx.copier.render({ resultId: empty.id, format: 'csv' })).toEqual({
      ok: false,
      error: 'no-rows',
    });
  });

  it('refuses more rows than one copy may carry', async () => {
    const { id } = add(
      ctx.results,
      Array.from({ length: MAX_COPY_ROWS + 1 }, (_, i) => [i, 'x']),
    );
    expect(await ctx.copier.render({ resultId: id, format: 'csv' })).toEqual({
      ok: false,
      error: 'too-many-rows',
    });
    expect((await ctx.copier.render({ resultId: id, format: 'csv', top: 0, bottom: 9 })).ok).toBe(
      true,
    );
  });

  it("renders SQL through the connection's dialect and passes refusals on", async () => {
    const { id } = add(ctx.results, [[1, 'a']]);
    const reply = await ctx.copier.render({ resultId: id, format: 'insert' });
    expect(reply).toMatchObject({ ok: true });
    expect(reply.ok && reply.text).toContain('INSERT INTO "table_name"');
    expect(await ctx.copier.render({ resultId: id, format: 'update' })).toEqual({
      ok: false,
      error: 'no-key',
    });
  });

  it('refuses SQL for a result without a known connection', async () => {
    const { id } = add(ctx.results, [[1, 'a']], { origin: undefined });
    expect(await ctx.copier.render({ resultId: id, format: 'insert' })).toEqual({
      ok: false,
      error: 'nothing-to-write',
    });
    expect((await ctx.copier.render({ resultId: id, format: 'csv' })).ok).toBe(true);
  });
});
