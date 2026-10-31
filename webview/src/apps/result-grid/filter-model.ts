// The filter bar's draft: what the user is typing, before it is sent. Pure, so every
// rule (which row is incomplete, what is sent) is a unit test.

import {
  conditionProblem,
  type FilterOperator,
  type FilterProblem,
  isEmptyFilter,
  MAX_FILTER_CONDITIONS,
  needsValue,
  type TableFilter,
} from '../../../../src/shared/table-filter';

export interface DraftCondition {
  /** Stable key for the row, so editing one does not recreate the others. */
  readonly id: number;
  readonly column: string;
  readonly operator: FilterOperator;
  readonly value: string;
  /** How the condition joins the one above it; the first one's is never used. */
  readonly join: 'and' | 'or';
}

export interface Draft {
  readonly conditions: readonly DraftCondition[];
  readonly where: string;
}

export function draftOf(filter: TableFilter | undefined): Draft {
  return {
    conditions: (filter?.conditions ?? []).map((condition, id) => ({
      id,
      column: condition.column,
      operator: condition.operator,
      value: condition.value ?? '',
      join: condition.join ?? 'and',
    })),
    where: filter?.where ?? '',
  };
}

/** The next free row key. */
function nextId(draft: Draft): number {
  return draft.conditions.reduce((max, condition) => Math.max(max, condition.id + 1), 0);
}

/** Adds an empty condition on a column; ignored once the limit is reached. */
export function addCondition(draft: Draft, column: string): Draft {
  if (draft.conditions.length >= MAX_FILTER_CONDITIONS) {
    return draft;
  }
  return {
    ...draft,
    conditions: [
      ...draft.conditions,
      { id: nextId(draft), column, operator: 'eq', value: '', join: 'and' },
    ],
  };
}

export function updateCondition(
  draft: Draft,
  id: number,
  change: Partial<Omit<DraftCondition, 'id'>>,
): Draft {
  return {
    ...draft,
    conditions: draft.conditions.map((condition) =>
      condition.id === id ? { ...condition, ...change } : condition,
    ),
  };
}

export function removeCondition(draft: Draft, id: number): Draft {
  return { ...draft, conditions: draft.conditions.filter((condition) => condition.id !== id) };
}

/** What is sent: no row keys, no value for operators that take none, no blank WHERE. */
export function filterOf(draft: Draft): TableFilter {
  const where = draft.where.trim();
  return {
    conditions: draft.conditions.map((condition, index) => ({
      column: condition.column,
      operator: condition.operator,
      ...(needsValue(condition.operator) ? { value: condition.value } : {}),
      ...(index > 0 && condition.join === 'or' ? { join: 'or' as const } : {}),
    })),
    ...(where === '' ? {} : { where }),
  };
}

/** Incomplete rows by key, so the bar can mark them and hold back Apply. */
export function draftProblems(draft: Draft): Map<number, FilterProblem> {
  const problems = new Map<number, FilterProblem>();
  for (const condition of draft.conditions) {
    const problem = conditionProblem({
      column: condition.column,
      operator: condition.operator,
      value: condition.value,
    });
    if (problem !== undefined) {
      problems.set(condition.id, problem);
    }
  }
  return problems;
}

/** True when the draft would send the same filter that is already applied. */
export function isUnchanged(draft: Draft, applied: TableFilter | undefined): boolean {
  const sent = filterOf(draft);
  const current = isEmptyFilter(applied) ? { conditions: [] } : applied;
  return JSON.stringify(normalize(sent)) === JSON.stringify(normalize(current));
}

function normalize(filter: TableFilter | undefined): unknown {
  return {
    conditions: (filter?.conditions ?? []).map((condition, index) => [
      condition.column,
      condition.operator,
      condition.value ?? null,
      index > 0 && condition.join === 'or' ? 'or' : 'and',
    ]),
    where: (filter?.where ?? '').trim(),
  };
}

/** How many conditions are in force, for the badge on the Filter button. */
export function activeCount(filter: TableFilter | undefined): number {
  if (isEmptyFilter(filter) || filter === undefined) {
    return 0;
  }
  return filter.conditions.length + ((filter.where ?? '').trim() === '' ? 0 : 1);
}

/** Flips how a condition joins the one above it. */
export function toggleJoin(draft: Draft, id: number): Draft {
  const current = draft.conditions.find((condition) => condition.id === id)?.join;
  return updateCondition(draft, id, { join: current === 'or' ? 'and' : 'or' });
}
