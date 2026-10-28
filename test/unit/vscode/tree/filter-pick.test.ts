import { describe, expect, it } from 'vitest';
import { initiallyPicked, pickOutcome, withList } from '../../../../src/vscode/tree/filter-pick';

const ALL = ['app', 'app_test', 'billing'];

describe('initiallyPicked', () => {
  it('ticks everything without a filter, and what the patterns show with one', () => {
    expect(initiallyPicked(ALL, [])).toEqual(ALL);
    expect(initiallyPicked(ALL, ['app*', '!app_test'])).toEqual(['app']);
  });
});

describe('pickOutcome', () => {
  it('drops the filter when everything is ticked', () => {
    expect(pickOutcome(ALL, ['billing', 'app', 'app_test'])).toEqual({ kind: 'all' });
  });

  it('keeps the ticked names in list order', () => {
    expect(pickOutcome(ALL, ['billing', 'app'])).toEqual({
      kind: 'some',
      patterns: ['app', 'billing'],
    });
  });

  it('refuses an empty pick and ignores names that are not listed', () => {
    expect(pickOutcome(ALL, [])).toEqual({ kind: 'none' });
    expect(pickOutcome(ALL, ['gone'])).toEqual({ kind: 'none' });
  });
});

describe('withList', () => {
  it('replaces one list and keeps the other', () => {
    expect(withList({ databases: ['a'], schemas: ['s'] }, 'databases', ['b'])).toEqual({
      databases: ['b'],
      schemas: ['s'],
    });
    expect(withList(undefined, 'schemas', ['public'])).toEqual({ schemas: ['public'] });
  });

  it('removes an emptied list, and the filter once nothing is left', () => {
    expect(withList({ databases: ['a'], schemas: ['s'] }, 'schemas', [])).toEqual({
      databases: ['a'],
    });
    expect(withList({ databases: ['a'] }, 'databases', [])).toBeUndefined();
    expect(withList(undefined, 'databases', [])).toBeUndefined();
  });
});
