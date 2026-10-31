import { describe, expect, it } from 'vitest';
import {
  activeCount,
  addCondition,
  draftOf,
  draftProblems,
  filterOf,
  isUnchanged,
  removeCondition,
  toggleJoin,
  updateCondition,
} from '../../../../../webview/src/apps/result-grid/filter-model';
import { MAX_FILTER_CONDITIONS } from '../../../../../src/shared/table-filter';

describe('draft editing', () => {
  it('starts empty without a filter and copies an applied one', () => {
    expect(draftOf(undefined)).toEqual({ conditions: [], where: '' });
    const draft = draftOf({
      conditions: [
        { column: 'a', operator: 'eq', value: '1' },
        { column: 'b', operator: 'isNull' },
      ],
      where: 'c > 2',
    });
    expect(draft.conditions.map((c) => [c.id, c.column, c.operator, c.value])).toEqual([
      [0, 'a', 'eq', '1'],
      [1, 'b', 'isNull', ''],
    ]);
    expect(draft.where).toBe('c > 2');
  });

  it('adds conditions with fresh keys, even after one was removed', () => {
    let draft = addCondition(draftOf(undefined), 'a');
    draft = addCondition(draft, 'b');
    draft = removeCondition(draft, 0);
    draft = addCondition(draft, 'c');
    expect(draft.conditions.map((c) => [c.id, c.column])).toEqual([
      [1, 'b'],
      [2, 'c'],
    ]);
  });

  it('stops adding at the limit', () => {
    let draft = draftOf(undefined);
    for (let i = 0; i < MAX_FILTER_CONDITIONS + 5; i += 1) {
      draft = addCondition(draft, 'a');
    }
    expect(draft.conditions).toHaveLength(MAX_FILTER_CONDITIONS);
  });

  it('changes only the row it was asked to', () => {
    let draft = addCondition(addCondition(draftOf(undefined), 'a'), 'b');
    draft = updateCondition(draft, 1, { operator: 'contains', value: 'x' });
    expect(draft.conditions[0]).toMatchObject({ operator: 'eq', value: '' });
    expect(draft.conditions[1]).toMatchObject({ operator: 'contains', value: 'x' });
  });
});

describe('filterOf', () => {
  it('drops keys, values of NULL checks and a blank WHERE', () => {
    const draft = updateCondition(
      updateCondition(addCondition(addCondition(draftOf(undefined), 'a'), 'b'), 0, {
        value: '5',
      }),
      1,
      { operator: 'isNull', value: 'left over' },
    );
    expect(filterOf({ ...draft, where: '  ' })).toEqual({
      conditions: [
        { column: 'a', operator: 'eq', value: '5' },
        { column: 'b', operator: 'isNull' },
      ],
    });
  });

  it('keeps the WHERE trimmed', () => {
    expect(filterOf({ conditions: [], where: '  a = 1 \n' })).toEqual({
      conditions: [],
      where: 'a = 1',
    });
  });

  it('sends a value exactly, spaces included', () => {
    const draft = updateCondition(addCondition(draftOf(undefined), 'a'), 0, { value: ' x ' });
    expect(filterOf(draft).conditions[0]?.value).toBe(' x ');
  });
});

describe('draftProblems', () => {
  it('flags rows without a value or without a column', () => {
    let draft = addCondition(addCondition(draftOf(undefined), 'a'), '');
    draft = updateCondition(draft, 1, { operator: 'isNull' });
    expect(draftProblems(draft)).toEqual(
      new Map([
        [0, 'missing-value'],
        [1, 'missing-column'],
      ]),
    );
  });

  it('is clean for complete rows', () => {
    const draft = updateCondition(addCondition(draftOf(undefined), 'a'), 0, { value: '1' });
    expect(draftProblems(draft).size).toBe(0);
  });
});

describe('isUnchanged', () => {
  const applied = { conditions: [{ column: 'a', operator: 'eq' as const, value: '1' }] };

  it('is true for the draft of the applied filter', () => {
    expect(isUnchanged(draftOf(applied), applied)).toBe(true);
  });

  it('treats nothing and an empty filter as the same', () => {
    expect(isUnchanged(draftOf(undefined), undefined)).toBe(true);
    expect(isUnchanged(draftOf(undefined), { conditions: [], where: ' ' })).toBe(true);
  });

  it('notices a changed value, operator, row and WHERE', () => {
    expect(isUnchanged(updateCondition(draftOf(applied), 0, { value: '2' }), applied)).toBe(false);
    expect(isUnchanged(updateCondition(draftOf(applied), 0, { operator: 'ne' }), applied)).toBe(
      false,
    );
    expect(isUnchanged(addCondition(draftOf(applied), 'b'), applied)).toBe(false);
    expect(isUnchanged({ ...draftOf(applied), where: 'x' }, applied)).toBe(false);
  });

  it('sees a first condition as a change from nothing', () => {
    expect(isUnchanged(addCondition(draftOf(undefined), 'a'), undefined)).toBe(false);
  });
});

describe('activeCount', () => {
  it('counts conditions and a hand-written WHERE', () => {
    expect(activeCount(undefined)).toBe(0);
    expect(activeCount({ conditions: [], where: ' ' })).toBe(0);
    expect(activeCount({ conditions: [{ column: 'a', operator: 'isNull' }], where: 'b > 1' })).toBe(
      2,
    );
  });
});

describe('AND / OR between conditions', () => {
  it('reads the join of a stored filter and defaults to AND', () => {
    const draft = draftOf({
      conditions: [
        { column: 'a', operator: 'eq', value: '1' },
        { column: 'b', operator: 'eq', value: '2', join: 'or' },
      ],
    });
    expect(draft.conditions.map((c) => c.join)).toEqual(['and', 'or']);
  });

  it('adds a condition that joins with AND', () => {
    expect(addCondition(draftOf(undefined), 'a').conditions[0]?.join).toBe('and');
  });

  it('flips a join and back', () => {
    const draft = addCondition(addCondition(draftOf(undefined), 'a'), 'b');
    const second = draft.conditions[1]?.id ?? -1;
    const flipped = toggleJoin(draft, second);
    expect(flipped.conditions[1]?.join).toBe('or');
    expect(toggleJoin(flipped, second).conditions[1]?.join).toBe('and');
  });

  it('sends the join only where it is OR and not on the first condition', () => {
    let draft = addCondition(addCondition(addCondition(draftOf(undefined), 'a'), 'b'), 'c');
    const [first, second, third] = draft.conditions.map((c) => c.id);
    draft = toggleJoin(toggleJoin(draft, first ?? 0), third ?? 0);
    draft = updateCondition(draft, second ?? 0, { operator: 'isNull' });
    expect(filterOf(draft).conditions.map((c) => c.join)).toEqual([undefined, undefined, 'or']);
  });

  it('counts a change of join as a change', () => {
    const applied = {
      conditions: [
        { column: 'a', operator: 'isNull' as const },
        { column: 'b', operator: 'isNull' as const },
      ],
    };
    const draft = draftOf(applied);
    expect(isUnchanged(draft, applied)).toBe(true);
    expect(isUnchanged(toggleJoin(draft, draft.conditions[1]?.id ?? 0), applied)).toBe(false);
    // The first condition's join never reaches the server, so it is not a change.
    expect(isUnchanged(toggleJoin(draft, draft.conditions[0]?.id ?? 0), applied)).toBe(true);
  });
});
