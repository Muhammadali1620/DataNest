import { describe, expect, it } from 'vitest';
import {
  cellText,
  deleteRequest,
  formatBytes,
  formatTtl,
  hexOf,
  initialMode,
  itemKey,
  parseTtlSeconds,
  prettyJson,
  saveRequest,
  shownText,
  typedValue,
} from '../../../../../webview/src/apps/redis-key/key-view';

const text = (value: string) => ({ text: value });

describe('formatTtl / formatBytes / parseTtlSeconds', () => {
  it('shows the time left to the second', () => {
    expect(formatTtl(7_000)).toBe('00:00:07');
    expect(formatTtl(3_723_999)).toBe('01:02:03');
    expect(formatTtl(2 * 86_400_000 + 5_000)).toBe('2d 00:00:05');
    expect(formatTtl(-50)).toBe('00:00:00');
  });

  it('shows sizes in the unit that fits', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(20 * 1024 * 1024)).toBe('20.0 MB');
    expect(formatBytes(5 * 1024 ** 5)).toBe('5120.0 TB');
  });

  it('takes whole positive seconds only', () => {
    expect(parseTtlSeconds(' 60 ')).toBe(60);
    for (const typed of ['', '0', '-1', '1.5', 'x']) {
      expect(parseTtlSeconds(typed), typed).toBeUndefined();
    }
  });
});

describe('value modes', () => {
  it('pretty prints JSON objects and arrays only', () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson('42')).toBeUndefined();
    expect(prettyJson('{broken')).toBeUndefined();
  });

  it('opens hex for bytes, JSON for JSON, text otherwise', () => {
    expect(initialMode({ text: '', hex: '00' })).toBe('hex');
    expect(initialMode(text('[1]'))).toBe('json');
    expect(initialMode(text('plain'))).toBe('text');
  });

  it('shows hex in pairs, 16 to a line', () => {
    expect(hexOf(text('AB'))).toBe('41 42');
    expect(hexOf({ text: '', hex: '00'.repeat(17) })).toBe(`${'00 '.repeat(15)}00\n00`);
    expect(shownText(text('{"a":1}'), 'json')).toBe('{\n  "a": 1\n}');
    expect(shownText(text('{x'), 'json')).toBe('{x');
    expect(shownText(text('x'), 'text')).toBe('x');
  });

  it('turns typed hex into text when it is UTF-8, else keeps the bytes', () => {
    expect(typedValue('41 42', 'hex')).toEqual(text('AB'));
    expect(typedValue('00 ff', 'hex')).toEqual({ text: '', hex: '00ff' });
    expect(typedValue('4', 'hex')).toBeUndefined();
    expect(typedValue('{ "a" : 1 }', 'json')).toEqual(text('{ "a" : 1 }'));
  });

  it('shows a cell on one line, cut', () => {
    expect(cellText(text('a\nb'))).toBe('a↵b');
    expect(cellText(text('x'.repeat(10)), 4)).toBe('xxxx…');
    expect(cellText(undefined)).toBe('');
  });
});

describe('saveRequest', () => {
  it('adds or changes a hash field, renaming it when the name changed', () => {
    expect(saveRequest('hash', undefined, { field: text('f'), value: text('v') })).toEqual({
      method: 'setField',
      params: { field: text('f'), value: text('v') },
    });
    expect(
      saveRequest('hash', { field: text('f') }, { field: text('g'), value: text('v') }),
    ).toEqual({
      method: 'setField',
      params: { field: text('g'), value: text('v'), previous: text('f') },
    });
    expect(
      saveRequest('hash', { field: text('f') }, { field: text('f'), value: text('v') })?.params,
    ).not.toHaveProperty('previous');
    expect(saveRequest('hash', undefined, { field: undefined, value: text('v') })).toBeUndefined();
  });

  it('pushes a new list element and sets one in place', () => {
    expect(saveRequest('list', undefined, { value: text('v'), end: 'head' })).toEqual({
      method: 'pushListItem',
      params: { end: 'head', value: text('v') },
    });
    expect(saveRequest('list', { index: 2, value: text('old') }, { value: text('new') })).toEqual({
      method: 'setListItem',
      params: { index: 2, expected: text('old'), value: text('new') },
    });
    expect(saveRequest('list', undefined, { value: undefined })).toBeUndefined();
  });

  it('adds or replaces members, with their scores', () => {
    expect(saveRequest('set', { value: text('a') }, { value: text('b') })).toEqual({
      method: 'setMember',
      params: { value: text('b'), previous: text('a') },
    });
    expect(saveRequest('zset', undefined, { value: text('a'), score: ' 3 ' })).toEqual({
      method: 'setScoredMember',
      params: { value: text('a'), score: '3' },
    });
    expect(saveRequest('zset', undefined, { value: text('a'), score: ' ' })).toBeUndefined();
  });

  it('adds a stream entry with its non-empty fields, and never changes one', () => {
    expect(
      saveRequest('stream', undefined, {
        id: ' ',
        pairs: [
          { field: 'a', value: '1' },
          { field: '', value: 'skipped' },
        ],
      }),
    ).toEqual({
      method: 'addEntry',
      params: { id: '*', fields: [{ field: text('a'), value: text('1') }] },
    });
    expect(
      saveRequest('stream', undefined, { pairs: [{ field: '', value: 'x' }] }),
    ).toBeUndefined();
    expect(
      saveRequest('stream', { id: '1-1' }, { pairs: [{ field: 'a', value: '1' }] }),
    ).toBeUndefined();
    expect(saveRequest('ReJSON-RL', undefined, { value: text('x') })).toBeUndefined();
  });
});

describe('deleteRequest / itemKey', () => {
  it('removes an item the way its type does', () => {
    expect(deleteRequest('hash', { field: text('f') })?.method).toBe('deleteField');
    expect(deleteRequest('list', { index: 1, value: text('v') })).toEqual({
      method: 'removeListItem',
      params: { index: 1, expected: text('v') },
    });
    expect(deleteRequest('zset', { value: text('m') })?.method).toBe('deleteMember');
    expect(deleteRequest('stream', { id: '1-1' })).toEqual({
      method: 'deleteEntry',
      params: { id: '1-1' },
    });
    expect(deleteRequest('hash', {})).toBeUndefined();
    expect(deleteRequest('other', { value: text('x') })).toBeUndefined();
  });

  it('tells items apart by id, position or content', () => {
    expect(itemKey({ id: '1-1' })).toBe('id:1-1');
    expect(itemKey({ index: 3, value: text('x') })).toBe('ix:3');
    expect(itemKey({ field: text('f'), value: text('v') })).not.toBe(
      itemKey({ field: text('f'), value: text('w') }),
    );
    expect(itemKey({ value: { text: 'a', hex: '00' } })).not.toBe(itemKey({ value: text('a') }));
  });
});
