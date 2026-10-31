// Filtering one column from its header: the distinct values to offer, and how a choice
// merges into the filter the table already has. Pure, so the rules are tested.

import { cellText } from '../../../../src/shared/cell-text';
import type { CellValue } from '../../../../src/shared/cell-value';
import {
  type FilterCondition,
  type FilterOperator,
  MAX_FILTER_CONDITIONS,
  needsValue,
  type TableFilter,
} from '../../../../src/shared/table-filter';

/** At most this many distinct values are offered; a column of ids would be a wall. */
export const MAX_DISTINCT_VALUES = 200;

/** Longest value listed in full; longer ones are cut in the list but filter by their start. */
const MAX_VALUE_LENGTH = 120;

export interface DistinctValues {
  readonly values: readonly string[];
  /** True when more distinct values exist than the list shows. */
  readonly more: boolean;
}

/** The distinct non-NULL values of a column among the rows that have arrived, in first-seen order. */
export function distinctValues(
  rows: readonly (readonly CellValue[] | undefined)[],
  column: number,
  limit = MAX_DISTINCT_VALUES,
): DistinctValues {
  const seen = new Set<string>();
  let more = false;
  for (const row of rows) {
    const value = row?.[column];
    if (value === undefined || value === null) {
      continue;
    }
    const text = cellText(value, { nullText: '' }).slice(0, MAX_VALUE_LENGTH);
    if (seen.has(text)) {
      continue;
    }
    if (seen.size >= limit) {
      more = true;
      break;
    }
    seen.add(text);
  }
  return { values: [...seen], more };
}

/** The condition on this column in a filter, if it has one (the first when there are several). */
export function conditionOn(
  filter: TableFilter | undefined,
  column: string,
): FilterCondition | undefined {
  return filter?.conditions.find((condition) => condition.column === column);
}

/** The columns a filter has conditions on, by name. */
export function filteredColumnNames(filter: TableFilter | undefined): ReadonlySet<string> {
  return new Set(filter?.conditions.map((condition) => condition.column) ?? []);
}

/**
 * The filter with this column's conditions replaced by one new condition (or just removed
 * when `condition` is undefined). Other columns' conditions and the free WHERE stay.
 * Returns null when nothing is left, which removes the filter.
 */
export function withColumnCondition(
  filter: TableFilter | undefined,
  column: string,
  condition: { operator: FilterOperator; value?: string } | undefined,
): TableFilter | null {
  const others = (filter?.conditions ?? []).filter((existing) => existing.column !== column);
  const conditions: FilterCondition[] =
    condition === undefined
      ? others
      : [
          ...others,
          needsValue(condition.operator)
            ? { column, operator: condition.operator, value: condition.value ?? '' }
            : { column, operator: condition.operator },
        ];
  const where = filter?.where?.trim() === '' ? undefined : filter?.where;
  if (conditions.length === 0 && where === undefined) {
    return null;
  }
  return {
    conditions: conditions.slice(0, MAX_FILTER_CONDITIONS),
    ...(where === undefined ? {} : { where }),
  };
}
