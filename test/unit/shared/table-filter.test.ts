import { describe, expect, it } from 'vitest';
import {
  conditionProblem,
  FILTER_OPERATORS,
  isEmptyFilter,
  needsValue,
  tableFilterSchema,
} from '../../../src/shared/table-filter';

describe('needsValue', () => {
  it('asks for a value for everything except the NULL checks', () => {
    for (const operator of FILTER_OPERATORS) {
      expect(needsValue(operator)).toBe(operator !== 'isNull' && operator !== 'notNull');
    }
  });
});

describe('conditionProblem', () => {
  it('accepts a complete condition', () => {
    expect(conditionProblem({ column: 'id', operator: 'eq', value: '1' })).toBeUndefined();
    expect(conditionProblem({ column: 'id', operator: 'isNull' })).toBeUndefined();
  });

  it('wants a value where one is compared', () => {
    expect(conditionProblem({ column: 'id', operator: 'eq' })).toBe('missing-value');
    expect(conditionProblem({ column: 'id', operator: 'contains', value: '' })).toBe(
      'missing-value',
    );
  });

  it('accepts a value made only of spaces: it is a real value', () => {
    expect(conditionProblem({ column: 'name', operator: 'eq', value: ' ' })).toBeUndefined();
  });

  it('wants a column', () => {
    expect(conditionProblem({ column: '  ', operator: 'isNull' })).toBe('missing-column');
  });
});

describe('isEmptyFilter', () => {
  it('is empty without conditions and without a WHERE', () => {
    expect(isEmptyFilter(undefined)).toBe(true);
    expect(isEmptyFilter({ conditions: [] })).toBe(true);
    expect(isEmptyFilter({ conditions: [], where: '  \n ' })).toBe(true);
  });

  it('is not empty with either part', () => {
    expect(isEmptyFilter({ conditions: [], where: 'a = 1' })).toBe(false);
    expect(isEmptyFilter({ conditions: [{ column: 'a', operator: 'isNull' }] })).toBe(false);
  });
});

describe('tableFilterSchema', () => {
  it('accepts a filter and rejects unknown operators, extra keys and too many conditions', () => {
    expect(() =>
      tableFilterSchema.parse({ conditions: [{ column: 'a', operator: 'eq', value: '1' }] }),
    ).not.toThrow();
    expect(() =>
      tableFilterSchema.parse({ conditions: [{ column: 'a', operator: 'regex', value: '1' }] }),
    ).toThrow();
    expect(() => tableFilterSchema.parse({ conditions: [], extra: 1 })).toThrow();
    const many = Array.from({ length: 21 }, () => ({ column: 'a', operator: 'isNull' }));
    expect(() => tableFilterSchema.parse({ conditions: many })).toThrow();
  });

  it('rejects an empty column name', () => {
    expect(() =>
      tableFilterSchema.parse({ conditions: [{ column: '', operator: 'isNull' }] }),
    ).toThrow();
  });
});
