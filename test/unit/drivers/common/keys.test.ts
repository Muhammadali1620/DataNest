import { describe, expect, it } from 'vitest';
import { groupKeys } from '../../../../src/drivers/common/keys';

describe('groupKeys', () => {
  it('groups rows by index and keeps column order', () => {
    expect(
      groupKeys([
        ['a', 'x'],
        ['a', 'y'],
        ['b', 'z'],
      ]),
    ).toEqual([['x', 'y'], ['z']]);
  });

  it('drops an index with an expression column whole', () => {
    expect(
      groupKeys([
        ['a', 'x'],
        ['a', undefined],
        ['b', 'z'],
      ]),
    ).toEqual([['z']]);
  });

  it('keeps an index dropped when more of its columns follow the expression', () => {
    expect(
      groupKeys([
        ['a', 'x'],
        ['a', undefined],
        ['a', 'y'],
      ]),
    ).toEqual([]);
  });

  it('ignores rows without an index name and returns nothing for no rows', () => {
    expect(groupKeys([[undefined, 'x']])).toEqual([]);
    expect(groupKeys([])).toEqual([]);
  });
});
