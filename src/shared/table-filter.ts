// The filter of a table view: structured conditions plus an optional hand-written
// WHERE. Both sides use these types, and the page checks a draft with the same
// rules the host applies, so a problem is shown before anything is sent.

import { array, type Infer, literal, object, optional, string } from './schema';

export const FILTER_OPERATORS = [
  'eq',
  'ne',
  'lt',
  'le',
  'gt',
  'ge',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isNull',
  'notNull',
] as const;

export type FilterOperator = (typeof FILTER_OPERATORS)[number];

/** Operators that compare against nothing, so no value is asked for. */
const VALUELESS: readonly FilterOperator[] = ['isNull', 'notNull'];

export function needsValue(operator: FilterOperator): boolean {
  return !VALUELESS.includes(operator);
}

export const MAX_FILTER_CONDITIONS = 20;
export const MAX_FILTER_VALUE_LENGTH = 10_000;
export const MAX_FILTER_WHERE_LENGTH = 10_000;

export const filterConditionSchema = object({
  column: string({ minLength: 1, maxLength: 1000 }),
  operator: literal(...FILTER_OPERATORS),
  value: optional(string({ maxLength: MAX_FILTER_VALUE_LENGTH })),
});

export const tableFilterSchema = object({
  conditions: array(filterConditionSchema, { maxLength: MAX_FILTER_CONDITIONS }),
  /** Free-form condition, joined to the others with AND. */
  where: optional(string({ maxLength: MAX_FILTER_WHERE_LENGTH })),
});

export type FilterCondition = Infer<typeof filterConditionSchema>;
export type TableFilter = Infer<typeof tableFilterSchema>;

export const FILTER_PROBLEMS = ['missing-value', 'missing-column'] as const;
export type FilterProblem = (typeof FILTER_PROBLEMS)[number];

/** What is wrong with a condition, or undefined when it can be sent. */
export function conditionProblem(condition: FilterCondition): FilterProblem | undefined {
  if (condition.column.trim() === '') {
    return 'missing-column';
  }
  if (needsValue(condition.operator) && (condition.value ?? '') === '') {
    return 'missing-value';
  }
  return undefined;
}

/** True when the filter would not narrow anything down. */
export function isEmptyFilter(filter: TableFilter | undefined): boolean {
  return (
    filter === undefined || (filter.conditions.length === 0 && (filter.where ?? '').trim() === '')
  );
}
