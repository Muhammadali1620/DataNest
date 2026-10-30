import { describe, expect, it } from 'vitest';
import type { SchemaCompareItem } from '../../../../../src/shared/protocols/schema-compare';
import {
  counts,
  defaultSelection,
  groupByKind,
  selectable,
} from '../../../../../webview/src/apps/schema-compare/compare-view';

const item = (
  id: string,
  kind: SchemaCompareItem['kind'],
  status: SchemaCompareItem['status'],
  hidden = false,
): SchemaCompareItem => ({ id, kind, name: id, status, ...(hidden ? { hidden: true } : {}) });

const items = [
  item('b', 'table', 'added'),
  item('a', 'table', 'removed'),
  item('c', 'table', 'changed'),
  item('d', 'table', 'same'),
  item('v', 'view', 'changed'),
  item('f', 'function', 'added', true),
];

describe('compare view', () => {
  it('ticks new and changed differences, never drops or hidden ones', () => {
    expect(defaultSelection(items)).toEqual(['b', 'c', 'v']);
    expect(items.map(selectable)).toEqual([true, true, true, false, true, false]);
  });

  it('groups by kind with differences first', () => {
    expect(
      groupByKind(items, false).map((group) => [group.kind, group.items.map((one) => one.id)]),
    ).toEqual([
      ['table', ['c', 'b', 'a']],
      ['view', ['v']],
      ['function', ['f']],
    ]);
    expect(groupByKind(items, true)[0]?.items.map((one) => one.id)).toEqual(['c', 'b', 'a', 'd']);
    expect(groupByKind([], true)).toEqual([]);
  });

  it('counts each status', () => {
    expect(counts(items)).toEqual({ added: 2, removed: 1, changed: 2, same: 1 });
  });
});
