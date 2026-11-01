import { describe, expect, it } from 'vitest';
import type { JsonNodeInfo } from '../../../../../src/shared/protocols/redis-key';
import { createTranslator } from '../../../../../webview/src/lib/i18n';
import {
  iconOf,
  isContainer,
  kindName,
  labelOf,
  type LoadedMap,
  moveTo,
  type OpenMap,
  rowsOf,
  summaryOf,
  toneColor,
  toneOf,
  treeKeyOf,
} from '../../../../../webview/src/apps/redis-key/json-view';

const t = createTranslator('en');
const ru = createTranslator('ru');

const root: JsonNodeInfo = { path: '$', label: '$', kind: 'object', size: 2 };
const list: JsonNodeInfo = { path: '$["list"]', label: 'list', kind: 'array', size: 2 };
const name: JsonNodeInfo = { path: '$["name"]', label: 'name', kind: 'string', preview: 'Ann' };
const first: JsonNodeInfo = { path: '$["list"][0]', label: '0', kind: 'integer', preview: '7' };
const second: JsonNodeInfo = { path: '$["list"][1]', label: '1', kind: 'null', preview: 'null' };

const loaded: LoadedMap = {
  $: { nodes: [list, name], total: 2, more: false },
  '$["list"]': { nodes: [first, second], total: 5, more: true },
};

describe('isContainer', () => {
  it('is true for an object or array with members, not for an empty one or a scalar', () => {
    expect(isContainer(root)).toBe(true);
    expect(isContainer(list)).toBe(true);
    expect(isContainer({ ...root, size: 0 })).toBe(false);
    expect(isContainer({ ...root, size: undefined })).toBe(false);
    expect(isContainer(name)).toBe(false);
  });
});

describe('rowsOf', () => {
  it('shows only the root while nothing is open', () => {
    const rows = rowsOf(root, {}, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'node',
      depth: 0,
      open: false,
      expandable: true,
      loading: false,
    });
  });

  it('shows an open node as loading until its children arrive', () => {
    const rows = rowsOf(root, { $: true }, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ open: true, loading: true });
  });

  it('lists the children of the open nodes, deeper ones indented', () => {
    const open: OpenMap = { $: true, '$["list"]': true };
    const rows = rowsOf(root, open, loaded);
    expect(
      rows.map((row) => (row.type === 'node' ? `${String(row.depth)}:${row.node.label}` : 'more')),
    ).toEqual(['0:$', '1:list', '2:0', '2:1', 'more', '1:name']);
    const more = rows[4];
    expect(more).toEqual({ type: 'more', path: '$["list"]', depth: 2, shown: 2, total: 5 });
  });

  it('remembers the parent of each row and its kind', () => {
    const rows = rowsOf(root, { $: true, '$["list"]': true }, loaded);
    expect(rows[0]).toMatchObject({ parent: undefined, parentKind: undefined });
    expect(rows[2]).toMatchObject({ parent: '$["list"]', parentKind: 'array' });
    expect(rows[5]).toMatchObject({ parent: '$', parentKind: 'object' });
  });

  it('keeps a closed node closed even when its children are loaded', () => {
    const rows = rowsOf(root, { $: true }, loaded);
    expect(rows.map((row) => (row.type === 'node' ? row.node.label : 'more'))).toEqual([
      '$',
      'list',
      'name',
    ]);
  });

  it('does not open a scalar or an empty container', () => {
    const rows = rowsOf(name, { [name.path]: true }, {});
    expect(rows[0]).toMatchObject({ open: false, expandable: false, loading: false });
  });
});

describe('kinds', () => {
  it('groups the kinds into six tones, numbers together', () => {
    expect(toneOf('integer')).toBe('number');
    expect(toneOf('number')).toBe('number');
    expect(toneOf('object')).toBe('object');
    expect(toneOf('array')).toBe('array');
    expect(toneOf('string')).toBe('string');
    expect(toneOf('boolean')).toBe('boolean');
    expect(toneOf('null')).toBe('null');
    expect(toneOf('geometry')).toBe('null');
  });

  it('draws an icon and a colour for each, grey for null', () => {
    expect(iconOf('object')).toBe('symbol-structure');
    expect(iconOf('array')).toBe('symbol-array');
    expect(iconOf('string')).toBe('symbol-string');
    expect(iconOf('integer')).toBe('symbol-numeric');
    expect(iconOf('boolean')).toBe('symbol-boolean');
    expect(iconOf('null')).toBe('circle-slash');
    expect(toneColor('object')).toBe('blue');
    expect(toneColor('array')).toBe('purple');
    expect(toneColor('string')).toBe('green');
    expect(toneColor('number')).toBe('orange');
    expect(toneColor('boolean')).toBe('teal');
    expect(toneColor('null')).toBeUndefined();
  });

  it('names a kind in the language of the page, and keeps one it does not know', () => {
    expect(kindName('object', t)).toBe('object');
    expect(kindName('integer', ru)).toBe('целое');
    expect(kindName('null', ru)).toBe('нулевое');
    expect(kindName('geometry', t)).toBe('geometry');
  });
});

describe('summaryOf and labelOf', () => {
  it('writes sizes of containers and values of scalars', () => {
    expect(summaryOf(root, t)).toBe('2 members');
    expect(summaryOf(list, t)).toBe('2 items');
    expect(summaryOf(name, t)).toBe('"Ann"');
    expect(summaryOf(first, t)).toBe('7');
    expect(summaryOf({ path: '$', label: 'x', kind: 'string', size: 9000 }, t)).toBe(
      '9000 characters',
    );
    expect(summaryOf({ path: '$', label: 'x', kind: 'boolean' }, t)).toBe('');
    expect(summaryOf({ ...root, size: undefined }, t)).toBe('0 members');
  });

  it('quotes a string so a space or an empty string can be seen', () => {
    expect(summaryOf({ ...name, preview: '' }, t)).toBe('""');
    expect(summaryOf({ ...name, preview: ' a ' }, t)).toBe('" a "');
  });

  it('writes the root as the document, an item as [n], and a member by its name', () => {
    expect(labelOf(root, undefined, t)).toBe('JSON document');
    expect(labelOf(first, 'array', t)).toBe('[0]');
    expect(labelOf(name, 'object', t)).toBe('name');
    expect(labelOf(root, undefined, ru)).toBe('JSON-документ');
  });
});

describe('keys', () => {
  it('knows the keys of a tree', () => {
    expect(treeKeyOf('ArrowDown')).toBe('next');
    expect(treeKeyOf('ArrowUp')).toBe('previous');
    expect(treeKeyOf('Home')).toBe('first');
    expect(treeKeyOf('End')).toBe('last');
    expect(treeKeyOf('ArrowRight')).toBe('open');
    expect(treeKeyOf('ArrowLeft')).toBe('close');
    expect(treeKeyOf('a')).toBeUndefined();
  });

  const rows = rowsOf(root, { $: true, '$["list"]': true }, loaded);
  // $, list, 0, 1, more, name

  it('moves to the next and previous node, skipping the "load more" row', () => {
    expect(moveTo(rows, 0, 'next')).toBe(1);
    expect(moveTo(rows, 3, 'next')).toBe(5);
    expect(moveTo(rows, 5, 'next')).toBeUndefined();
    expect(moveTo(rows, 5, 'previous')).toBe(3);
    expect(moveTo(rows, 0, 'previous')).toBeUndefined();
  });

  it('moves to the first and last node', () => {
    expect(moveTo(rows, 3, 'first')).toBe(0);
    expect(moveTo(rows, 0, 'first')).toBeUndefined();
    expect(moveTo(rows, 0, 'last')).toBe(5);
    expect(moveTo(rows, 5, 'last')).toBeUndefined();
  });

  it('moves to the parent, and stays at the root', () => {
    expect(moveTo(rows, 2, 'parent')).toBe(1);
    expect(moveTo(rows, 5, 'parent')).toBe(0);
    expect(moveTo(rows, 0, 'parent')).toBeUndefined();
    expect(moveTo(rows, 4, 'parent')).toBeUndefined();
  });

  it('has nowhere to go in an empty list', () => {
    expect(moveTo([], 0, 'next')).toBeUndefined();
    expect(moveTo([], 0, 'first')).toBeUndefined();
    expect(moveTo([], 0, 'last')).toBeUndefined();
  });
});
