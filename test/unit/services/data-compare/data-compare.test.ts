import { describe, expect, it, vi } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { compareTableData, KEEP_ROWS } from '../../../../src/services/data-compare/data-compare';
import type { CellValue } from '../../../../src/shared/cell-value';
import { tableSession } from '../../../helpers/table-session';

function side(rows: CellValue[][], dialect = postgresDialect, gate?: Promise<void>) {
  const fake = tableSession(rows, gate === undefined ? {} : { gate });
  const release = vi.fn(() => Promise.resolve());
  return {
    fake,
    release,
    table: {
      table: dialect === mysqlDialect ? { database: 's', name: 't' } : { schema: 's', name: 't' },
      dialect,
      session: () => Promise.resolve(fake.session),
      release,
    },
  };
}

const KEY = [{ source: 'id', target: 'ID' }];
const COLUMNS = [
  { source: 'name', target: 'NAME' },
  { source: 'price', target: 'PRICE' },
];

describe('compareTableData', () => {
  it('counts same, different and missing rows and keeps the rows to show', async () => {
    const source = side(
      [
        [1, 'tea', 10.5],
        [2, 'coffee', 7],
        [3, 'milk', 2],
        [4, 'juice', 3],
      ],
      mysqlDialect,
    );
    const target = side([
      [1, 'tea', { kind: 'decimal', text: '10.50' }],
      [3, 'MILK', 2],
      [2, 'coffee', 7],
      [9, 'soda', 1],
    ]);
    const progress = vi.fn();
    const result = await compareTableData({
      source: source.table,
      target: target.table,
      key: KEY,
      columns: COLUMNS,
      onProgress: progress,
    });
    expect(result).toMatchObject({ same: 2, different: 1, onlySource: 1, onlyTarget: 1 });
    expect(result.differentRows).toEqual([{ source: [3, 'milk', 2], target: [3, 'MILK', 2] }]);
    expect(result.onlySourceRows).toEqual([[4, 'juice', 3]]);
    expect(result.onlyTargetRows).toEqual([[9, 'soda', 1]]);
    expect(source.fake.executed).toEqual(['SELECT `id`, `name`, `price` FROM `s`.`t`']);
    // Once for the hashes, once for the values of the rows to show.
    expect(target.fake.executed).toEqual([
      'SELECT "ID", "NAME", "PRICE" FROM "s"."t"',
      'SELECT "ID", "NAME", "PRICE" FROM "s"."t"',
    ]);
    expect(progress).toHaveBeenCalledWith({ phase: 'rows', rows: 0 });
    expect(source.release).toHaveBeenCalledTimes(1);
    expect(target.release).toHaveBeenCalledTimes(1);
  });

  it('reads the target only once when everything matches', async () => {
    const rows = [
      [1, 'a', 1],
      [2, 'b', 2],
    ];
    const target = side(rows);
    const result = await compareTableData({
      source: side(rows).table,
      target: target.table,
      key: KEY,
      columns: COLUMNS,
    });
    expect(result).toMatchObject({ same: 2, different: 0, onlySource: 0, onlyTarget: 0 });
    expect(target.fake.executed).toHaveLength(1);
  });

  it('compares by a composite key and with column modes', async () => {
    const result = await compareTableData({
      source: side([[1, 'x', { kind: 'json', text: '{"a":1,"b":2}' }]]).table,
      target: side([[1, 'x', '{"b": 2, "a": 1}']]).table,
      key: [
        { source: 'a', target: 'a' },
        { source: 'b', target: 'b' },
      ],
      columns: [{ source: 'doc', target: 'doc' }],
      modes: ['plain', 'plain', 'json'],
    });
    expect(result.same).toBe(1);
  });

  it('keeps at most so many rows of a kind, but counts them all', async () => {
    const many = Array.from({ length: KEEP_ROWS + 5 }, (_, index): CellValue[] => [index, 'x', 1]);
    const result = await compareTableData({
      source: side(many).table,
      target: side([]).table,
      key: KEY,
      columns: COLUMNS,
    });
    expect(result.onlySource).toBe(KEEP_ROWS + 5);
    expect(result.onlySourceRows).toHaveLength(KEEP_ROWS);
  });

  it('refuses keys that repeat on either side', async () => {
    await expect(
      compareTableData({
        source: side([]).table,
        target: side([
          [1, 'a', 1],
          [1, 'b', 2],
        ]).table,
        key: KEY,
        columns: COLUMNS,
      }),
    ).rejects.toThrow(/repeat in the target/u);
    await expect(
      compareTableData({
        source: side([
          [1, 'a', 1],
          [1, 'b', 2],
        ]).table,
        target: side([[1, 'a', 1]]).table,
        key: KEY,
        columns: COLUMNS,
      }),
    ).rejects.toThrow(/repeat in the source/u);
    await expect(
      compareTableData({
        source: side([
          [5, 'a', 1],
          [5, 'b', 2],
        ]).table,
        target: side([]).table,
        key: KEY,
        columns: COLUMNS,
      }),
    ).rejects.toMatchObject({ code: 'constraint' });
  });

  it('needs a key', async () => {
    await expect(
      compareTableData({
        source: side([]).table,
        target: side([]).table,
        key: [],
        columns: COLUMNS,
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('stops at once when cancelled before it starts', async () => {
    const abort = new AbortController();
    abort.abort();
    const target = side([[1, 'a', 1]]);
    await expect(
      compareTableData({
        source: side([]).table,
        target: target.table,
        key: KEY,
        columns: COLUMNS,
        signal: abort.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(target.fake.executed).toEqual([]);
  });

  it('asks the server to stop a read in flight and gives the sessions back', async () => {
    const abort = new AbortController();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const source = side([[1, 'a', 1]]);
    const target = side([[1, 'a', 1]], postgresDialect, gate);
    const running = compareTableData({
      source: source.table,
      target: target.table,
      key: KEY,
      columns: COLUMNS,
      signal: abort.signal,
    });
    const cancelled = expect(running).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => {
      expect(target.fake.executed).toHaveLength(1);
    });
    abort.abort();
    open();
    await cancelled;
    expect(target.fake.cancelled).toBe(1);
    expect(source.release).toHaveBeenCalled();
    expect(target.release).toHaveBeenCalled();
  });
});
