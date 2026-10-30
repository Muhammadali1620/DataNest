import { describe, expect, it } from 'vitest';
import {
  firstValue,
  namedRows,
  numberOf,
  textOf,
  toNumber,
} from '../../../../src/services/monitor/rows';
import type { CellValue } from '../../../../src/shared/cell-value';
import { scriptedSession } from '../../../helpers/scripted-session';

describe('namedRows', () => {
  it('names the columns of the last set in lower case', async () => {
    const { session } = scriptedSession(() => [
      { columns: ['First'], rows: [[1]] },
      {
        columns: ['ID', 'Name'],
        rows: [
          [2, 'x'],
          [3, null],
        ],
      },
    ]);
    const rows = await namedRows(session, 'EXEC p');
    expect(rows.map((row) => [...row.entries()])).toEqual([
      [
        ['id', 2],
        ['name', 'x'],
      ],
      [
        ['id', 3],
        ['name', null],
      ],
    ]);
  });

  it('gives nothing for a statement without rows', async () => {
    const { session } = scriptedSession(() => []);
    expect(await namedRows(session, 'KILL 1')).toEqual([]);
    expect(await firstValue(session, 'KILL 1')).toBeUndefined();
  });
});

describe('textOf and numberOf', () => {
  const row = new Map<string, CellValue>([
    ['n', { kind: 'decimal', text: '12.50' }],
    ['empty', ''],
    ['flag', true],
    ['none', null],
    ['word', 'abc'],
  ]);

  it('reads texts exactly, empty and NULL as absent', () => {
    expect(textOf(row, 'n')).toBe('12.50');
    expect(textOf(row, 'flag')).toBe('true');
    expect(textOf(row, 'empty')).toBeUndefined();
    expect(textOf(row, 'none')).toBeUndefined();
    expect(textOf(row, 'missing')).toBeUndefined();
  });

  it('reads numbers, and nothing for what is not one', () => {
    expect(numberOf(row, 'n')).toBe(12.5);
    expect(numberOf(row, 'word')).toBeUndefined();
    expect(toNumber(' ')).toBeUndefined();
    expect(toNumber('Infinity')).toBeUndefined();
    expect(toNumber('-3e2')).toBe(-300);
  });

  it('reads the first value of the first row', async () => {
    const { session } = scriptedSession(() => [{ columns: ['a', 'b'], rows: [[null, 2]] }]);
    expect(await firstValue(session, 'SELECT')).toBeUndefined();
    const two = scriptedSession(() => [
      { columns: ['a'], rows: [[{ kind: 'bigint', text: '9007199254740993' }]] },
    ]);
    expect(await firstValue(two.session, 'SELECT')).toBe('9007199254740993');
  });
});
