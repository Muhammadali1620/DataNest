import { describe, expect, it } from 'vitest';
import {
  cellClass,
  fieldName,
  groupDigits,
  nextSort,
  previousSkip,
  problemText,
  rangeOf,
  sortOf,
} from '../../../../../webview/src/apps/mongo-documents/documents-view';

describe('documents page helpers (V7.6)', () => {
  it('writes field names as the shell does', () => {
    expect(fieldName('status')).toBe('status');
    expect(fieldName('$x')).toBe('$x');
    expect(fieldName('a.b')).toBe('"a.b"');
    expect(fieldName('12')).toBe('"12"');
  });

  it('sorts a column ascending, then descending, then ascending again', () => {
    expect(nextSort('', 'status')).toBe('{ status: 1 }');
    expect(nextSort('{ status: 1 }', 'status')).toBe('{ status: -1 }');
    expect(nextSort('{  status:   1 }', 'status')).toBe('{ status: -1 }');
    expect(nextSort('{ status: -1 }', 'status')).toBe('{ status: 1 }');
    expect(nextSort('{ status: 1 }', 'a b')).toBe('{ "a b": 1 }');
  });

  it('knows which way the sort box orders a column', () => {
    expect(sortOf('{ status: 1 }', 'status')).toBe('asc');
    expect(sortOf('{ status: -1 }', 'status')).toBe('desc');
    expect(sortOf('{ status: 1, _id: 1 }', 'status')).toBeUndefined();
    expect(sortOf('', 'status')).toBeUndefined();
  });

  it('says where a problem is when it knows', () => {
    expect(problemText({ message: 'bad', box: 'filter' })).toBe('bad');
    expect(problemText({ message: 'bad', box: 'filter', line: 2, column: 7 })).toBe('2:7 bad');
  });

  it('numbers the rows of a page and the start of the one before', () => {
    expect(rangeOf(0, 0)).toEqual({ from: 0, to: 0 });
    expect(rangeOf(50, 50)).toEqual({ from: 51, to: 100 });
    expect(previousSkip(50, 20)).toBe(30);
    expect(previousSkip(10, 50)).toBe(0);
  });

  it('groups digits of any size', () => {
    expect(groupDigits('0')).toBe('0');
    expect(groupDigits('1234')).toBe('1 234');
    expect(groupDigits('9007199254740993', ',')).toBe('9,007,199,254,740,993');
  });

  it('styles values by their type', () => {
    expect(['int32', 'int64', 'double', 'decimal'].map(cellClass)).toEqual(Array(4).fill('number'));
    expect(cellClass('string')).toBe('string');
    expect(cellClass('null')).toBe('null');
    expect(cellClass('bool')).toBe('bool');
    expect(cellClass('objectId')).toBe('id');
    expect(cellClass('date')).toBe('date');
    expect(cellClass('array')).toBe('nested');
    expect(cellClass('minKey')).toBe('other');
  });
});
