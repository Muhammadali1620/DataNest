import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  type ConfigProperty,
  checkSetting,
  detailOf,
  groupOf,
  inlineSpans,
  knownIds,
  labelOf,
  SETTING_GROUPS,
} from '../../../../src/shared/tools/settings-map';

const PROPS: Record<string, ConfigProperty> = {
  'datanest.editor.codeLens': {
    type: 'boolean',
    default: true,
    description: 'Show Run above each statement. More.',
  },
  'datanest.safeMode': {
    type: 'string',
    enum: ['confirm', 'block', 'off'],
    default: 'confirm',
    description: 'What to do with a dangerous statement',
  },
  'datanest.pageSize': {
    type: 'integer',
    default: 200,
    minimum: 1,
    maximum: 1000,
    description: 'Rows per page.',
  },
  'datanest.queryTimeout': { type: 'number', default: 0, minimum: 0, description: 'Seconds' },
  'datanest.redis.keySeparator': { type: 'string', default: ':', description: 'Separator' },
  'datanest.logLevel': { type: 'string', enum: ['error', 'info'], default: 'info' },
  'datanest.complicated': { type: 'object', default: {}, description: 'Not shown' },
  'datanest.arrayTyped': {
    type: ['boolean', 'null'],
    default: false,
    description: 'First type wins',
  },
  'other.setting': { type: 'boolean', default: true },
};

describe('groupOf', () => {
  it('sorts settings into the page groups by id', () => {
    expect(groupOf('datanest.editor.codeLens')).toBe('editor');
    expect(groupOf('datanest.format.keywordCase')).toBe('format');
    expect(groupOf('datanest.redis.keysPerLoad')).toBe('redis');
    expect(groupOf('datanest.tree.tableStats')).toBe('tree');
    expect(groupOf('datanest.showSystemObjects')).toBe('tree');
    expect(groupOf('datanest.connections.sync')).toBe('tree');
    expect(groupOf('datanest.rowLimit')).toBe('result');
    expect(groupOf('datanest.pageSize')).toBe('result');
    for (const id of [
      'safeMode',
      'transactionMode',
      'queryVariables',
      'queryTimeout',
      'historyLimit',
    ]) {
      expect(groupOf(`datanest.${id}`)).toBe('sql');
    }
    expect(groupOf('datanest.logLevel')).toBe('general');
  });

  it('leaves out settings of other extensions', () => {
    expect(groupOf('editor.fontSize')).toBeUndefined();
    expect(groupOf('')).toBeUndefined();
  });
});

describe('labelOf', () => {
  it('is the first sentence without its full stop', () => {
    expect(labelOf('Show Run above each statement. More text.')).toBe(
      'Show Run above each statement',
    );
    expect(labelOf('One sentence only.')).toBe('One sentence only');
    expect(labelOf('No stop at all')).toBe('No stop at all');
    expect(labelOf('Is it? Yes.')).toBe('Is it');
    expect(labelOf('  spaced \n  out  text. ')).toBe('spaced out text');
    expect(labelOf('Uses e.g. a dot inside')).toBe('Uses e.g. a dot inside');
  });
});

describe('buildGroups', () => {
  const read = (id: string): unknown =>
    ({ 'datanest.pageSize': 50, 'datanest.safeMode': 'block' })[id];
  const groups = buildGroups(PROPS, read);
  const item = (id: string) => groups.flatMap((g) => g.items).find((i) => i.id === id);

  it('keeps the order of the groups and drops empty ones and foreign settings', () => {
    expect(groups.map((g) => g.id)).toEqual(['general', 'editor', 'sql', 'result', 'redis']);
    expect(item('other.setting')).toBeUndefined();
    expect(item('datanest.complicated')).toBeUndefined();
  });

  it('describes each kind of setting with its value and default', () => {
    expect(item('datanest.editor.codeLens')).toMatchObject({
      kind: 'boolean',
      label: 'Show Run above each statement',
      value: true,
      default: true,
    });
    expect(item('datanest.safeMode')).toMatchObject({
      kind: 'choice',
      value: 'block',
      default: 'confirm',
      choices: [
        { value: 'confirm', label: 'confirm' },
        { value: 'block', label: 'block' },
        { value: 'off', label: 'off' },
      ],
    });
    expect(item('datanest.pageSize')).toMatchObject({
      kind: 'number',
      value: 50,
      default: 200,
      min: 1,
      max: 1000,
      integer: true,
    });
    expect(item('datanest.queryTimeout')).not.toHaveProperty('integer');
    expect(item('datanest.redis.keySeparator')).toMatchObject({ kind: 'text', value: ':' });
  });

  it('takes the first of several types and falls back to the id for a missing description', () => {
    expect(item('datanest.arrayTyped')).toMatchObject({ kind: 'boolean' });
    expect(item('datanest.logLevel')?.label).toBe('datanest.logLevel');
  });

  it('shows the default when the editor holds a value of the wrong kind', () => {
    const odd = buildGroups(PROPS, () => ({ nope: true }));
    expect(odd.flatMap((g) => g.items).find((i) => i.id === 'datanest.pageSize')?.value).toBe(200);
  });

  it('gives a missing default a neutral value', () => {
    const bare = buildGroups(
      {
        'datanest.tree.a': { type: 'boolean' },
        'datanest.tree.b': { type: 'number', minimum: 5 },
        'datanest.tree.c': { type: 'string' },
      },
      () => undefined,
    );
    expect(bare[0]?.items.map((i) => i.default)).toEqual([false, 5, '']);
  });
});

describe('checkSetting', () => {
  it('accepts a value of the right kind and refuses the rest', () => {
    expect(checkSetting(PROPS, 'datanest.editor.codeLens', false)).toEqual({
      ok: true,
      value: false,
    });
    expect(checkSetting(PROPS, 'datanest.editor.codeLens', 'yes')).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'datanest.safeMode', 'off')).toEqual({ ok: true, value: 'off' });
    expect(checkSetting(PROPS, 'datanest.safeMode', 'sometimes')).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'datanest.safeMode', 1)).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'datanest.redis.keySeparator', '/')).toEqual({
      ok: true,
      value: '/',
    });
    expect(checkSetting(PROPS, 'datanest.redis.keySeparator', 'x'.repeat(201))).toEqual({
      ok: false,
    });
  });

  it('keeps numbers inside the schema', () => {
    expect(checkSetting(PROPS, 'datanest.pageSize', 1000)).toEqual({ ok: true, value: 1000 });
    expect(checkSetting(PROPS, 'datanest.pageSize', 0)).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'datanest.pageSize', 1001)).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'datanest.pageSize', 1.5)).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'datanest.pageSize', Number.NaN)).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'datanest.pageSize', '5')).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'datanest.queryTimeout', 2.5)).toEqual({ ok: true, value: 2.5 });
    expect(checkSetting(PROPS, 'datanest.queryTimeout', -1)).toEqual({ ok: false });
  });

  it('refuses an unknown setting, a foreign one and one of an unsupported kind', () => {
    expect(checkSetting(PROPS, 'datanest.nope', true)).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'other.setting', true)).toEqual({ ok: false });
    expect(checkSetting(PROPS, 'datanest.complicated', {})).toEqual({ ok: false });
    expect(checkSetting(PROPS, '__proto__', true)).toEqual({ ok: false });
  });
});

describe('knownIds', () => {
  it('lists the ids the page may reset', () => {
    expect(knownIds(PROPS).sort()).toEqual(
      [
        'datanest.arrayTyped',
        'datanest.editor.codeLens',
        'datanest.logLevel',
        'datanest.pageSize',
        'datanest.queryTimeout',
        'datanest.redis.keySeparator',
        'datanest.safeMode',
      ].sort(),
    );
  });
});

describe("the extension's own package.json", () => {
  const manifest = JSON.parse(
    readFileSync(join(__dirname, '../../../../package.json'), 'utf8'),
  ) as {
    contributes: {
      configuration:
        | { properties: Record<string, ConfigProperty> }
        | { properties: Record<string, ConfigProperty> }[];
    };
  };
  const blocks = Array.isArray(manifest.contributes.configuration)
    ? manifest.contributes.configuration
    : [manifest.contributes.configuration];
  const properties = Object.assign({}, ...blocks.map((block) => block.properties)) as Record<
    string,
    ConfigProperty
  >;

  it('shows every setting it declares, each with a group and a default of its own kind', () => {
    const shown = buildGroups(properties, () => undefined).flatMap((group) => group.items);
    expect(shown.map((i) => i.id).sort()).toEqual(Object.keys(properties).sort());
    for (const entry of shown) {
      expect(SETTING_GROUPS).toContain(groupOf(entry.id));
      expect(entry.label.length, entry.id).toBeGreaterThan(0);
      expect(entry.default, entry.id).toBe(properties[entry.id]?.default);
      expect(checkSetting(properties, entry.id, entry.default), entry.id).toEqual({
        ok: true,
        value: entry.default,
      });
    }
  });
});

describe('inlineSpans', () => {
  it('splits plain text, `code` and **bold** in order', () => {
    expect(inlineSpans('Show **Run** above `Ctrl+Enter` runs')).toEqual([
      { text: 'Show ', style: 'plain' },
      { text: 'Run', style: 'bold' },
      { text: ' above ', style: 'plain' },
      { text: 'Ctrl+Enter', style: 'code' },
      { text: ' runs', style: 'plain' },
    ]);
  });

  it('keeps an unclosed mark as typed and never makes markup out of angle brackets', () => {
    expect(inlineSpans('a `b and **c <b>x</b>')).toEqual([
      { text: 'a `b and **c <b>x</b>', style: 'plain' },
    ]);
  });

  it('is empty for an empty text and one plain span for plain text', () => {
    expect(inlineSpans('')).toEqual([]);
    expect(inlineSpans('plain')).toEqual([{ text: 'plain', style: 'plain' }]);
  });

  it('reads two marks side by side and a mark at the very start or end', () => {
    expect(inlineSpans('`a`**b**')).toEqual([
      { text: 'a', style: 'code' },
      { text: 'b', style: 'bold' },
    ]);
  });
});

describe('detailOf', () => {
  it('is what follows the first sentence', () => {
    expect(detailOf('Rows per page. A table opens with this many. More.')).toBe(
      'A table opens with this many. More.',
    );
  });

  it('is empty for one sentence, with or without the stop', () => {
    expect(detailOf('Rows per page.')).toBe('');
    expect(detailOf('Rows per page')).toBe('');
  });

  it('does not cut at e.g. before a lower-case word', () => {
    expect(detailOf('Splits names, e.g. user:1 into folders. Then more.')).toBe('Then more.');
  });
});
