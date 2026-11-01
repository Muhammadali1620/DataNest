import { describe, expect, it } from 'vitest';
import {
  deleteJson,
  isJsonType,
  itemPath,
  JSON_KEY_TYPE,
  JSON_PAGE_SIZE,
  MAX_JSON_PATH,
  MAX_JSON_READ_BYTES,
  MAX_JSON_TEXT,
  memberPath,
  readJsonChildren,
  readJsonRoot,
  readJsonText,
  setJson,
} from '../../../../src/services/redis/key-json';
import { FakeJsonSession } from '../../../helpers/fake-redisjson';

const key = new TextEncoder().encode('doc');

const DOCUMENT = {
  name: 'Ann',
  age: 30,
  ratio: 0.5,
  ok: true,
  none: null,
  tags: ['a', 'b'],
  nested: { x: { y: 1 } },
  'we"ird\\key': 1,
  'sp ace': 2,
  empty: {},
  list: [],
};

describe('key type', () => {
  it('knows the type name of the module', () => {
    expect(JSON_KEY_TYPE).toBe('ReJSON-RL');
    expect(isJsonType('ReJSON-RL')).toBe(true);
    expect(isJsonType('hash')).toBe(false);
    expect(isJsonType('rejson-rl')).toBe(false);
  });
});

describe('paths', () => {
  it('steps into a member by its quoted name, whatever the name holds', () => {
    expect(memberPath('$', 'name')).toBe('$["name"]');
    expect(memberPath('$["a"]', 'b c')).toBe('$["a"]["b c"]');
    expect(memberPath('$', 'say "hi"')).toBe('$["say \\"hi\\""]');
    expect(memberPath('$', 'a\\b')).toBe('$["a\\\\b"]');
    expect(memberPath('$', '')).toBe('$[""]');
  });

  it('steps into an item by position', () => {
    expect(itemPath('$["tags"]', 0)).toBe('$["tags"][0]');
    expect(itemPath('$', 12)).toBe('$[12]');
  });
});

describe('readJsonRoot', () => {
  it('tells the kind and the size of the document', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    expect(await readJsonRoot(session, key)).toEqual({
      path: '$',
      label: '$',
      kind: 'object',
      size: 11,
    });
  });

  it('shows a scalar document by its value', async () => {
    expect(await readJsonRoot(new FakeJsonSession(42), key)).toEqual({
      path: '$',
      label: '$',
      kind: 'integer',
      preview: '42',
    });
    expect(await readJsonRoot(new FakeJsonSession('hi'), key)).toMatchObject({
      kind: 'string',
      size: 2,
      preview: 'hi',
    });
    expect(await readJsonRoot(new FakeJsonSession([1, 2, 3]), key)).toMatchObject({
      kind: 'array',
      size: 3,
    });
  });

  it("fails with the server's words when the module is missing", async () => {
    const session = new FakeJsonSession(DOCUMENT, { noModule: true });
    await expect(readJsonRoot(session, key)).rejects.toThrow(/unknown command/);
  });

  it('fails when the key has no JSON value', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await expect(readJsonRoot(session, new TextEncoder().encode('other'))).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('readJsonChildren', () => {
  it('lists the members of an object with kind, size and value', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    const { nodes, total, more } = await readJsonChildren(session, key, '$', 0);
    expect(total).toBe(11);
    expect(more).toBe(false);
    expect(nodes.map((node) => node.label)).toEqual(Object.keys(DOCUMENT));
    const byLabel = Object.fromEntries(nodes.map((node) => [node.label, node]));
    expect(byLabel.name).toEqual({
      path: '$["name"]',
      label: 'name',
      kind: 'string',
      size: 3,
      preview: 'Ann',
    });
    expect(byLabel.age).toEqual({
      path: '$["age"]',
      label: 'age',
      kind: 'integer',
      preview: '30',
    });
    expect(byLabel.ratio).toMatchObject({ kind: 'number', preview: '0.5' });
    expect(byLabel.ok).toMatchObject({ kind: 'boolean', preview: 'true' });
    expect(byLabel.none).toMatchObject({ kind: 'null', preview: 'null' });
    expect(byLabel.tags).toEqual({ path: '$["tags"]', label: 'tags', kind: 'array', size: 2 });
    expect(byLabel.nested).toEqual({
      path: '$["nested"]',
      label: 'nested',
      kind: 'object',
      size: 1,
    });
    expect(byLabel.empty).toMatchObject({ kind: 'object', size: 0 });
    expect(byLabel.list).toMatchObject({ kind: 'array', size: 0 });
    // A name with a quote and a backslash is reachable by the path it comes with.
    expect(byLabel['we"ird\\key']?.path).toBe(memberPath('$', 'we"ird\\key'));
  });

  it('lists the items of an array', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    const { nodes, total } = await readJsonChildren(session, key, '$["tags"]', 0);
    expect(total).toBe(2);
    expect(nodes).toEqual([
      { path: '$["tags"][0]', label: '0', kind: 'string', size: 1, preview: 'a' },
      { path: '$["tags"][1]', label: '1', kind: 'string', size: 1, preview: 'b' },
    ]);
  });

  it('opens a node level by level', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    const first = await readJsonChildren(session, key, '$["nested"]', 0);
    expect(first.nodes.map((node) => node.path)).toEqual(['$["nested"]["x"]']);
    const second = await readJsonChildren(session, key, '$["nested"]["x"]', 0);
    expect(second.nodes).toEqual([
      { path: '$["nested"]["x"]["y"]', label: 'y', kind: 'integer', preview: '1' },
    ]);
  });

  it('pages a long array and says when there is more', async () => {
    const count = JSON_PAGE_SIZE + 30;
    const session = new FakeJsonSession(Array.from({ length: count }, (_, index) => index));
    const first = await readJsonChildren(session, key, '$', 0);
    expect(first.nodes).toHaveLength(JSON_PAGE_SIZE);
    expect(first.more).toBe(true);
    expect(first.total).toBe(count);
    const second = await readJsonChildren(session, key, '$', JSON_PAGE_SIZE);
    expect(second.nodes).toHaveLength(30);
    expect(second.nodes[0]?.label).toBe(String(JSON_PAGE_SIZE));
    expect(second.more).toBe(false);
  });

  it('pages a big object by member', async () => {
    const object = Object.fromEntries(
      Array.from({ length: JSON_PAGE_SIZE + 5 }, (_, index) => [`k${String(index)}`, index]),
    );
    const session = new FakeJsonSession(object);
    const second = await readJsonChildren(session, key, '$', JSON_PAGE_SIZE);
    expect(second.nodes.map((node) => node.label)).toEqual([
      'k200',
      'k201',
      'k202',
      'k203',
      'k204',
    ]);
    expect(second.total).toBe(JSON_PAGE_SIZE + 5);
    expect(second.more).toBe(false);
  });

  it('asks the server for one page of values, not for all', async () => {
    const session = new FakeJsonSession(
      Array.from({ length: JSON_PAGE_SIZE * 3 }, (_, index) => index),
    );
    await readJsonChildren(session, key, '$', 0);
    const gets = session.calls.filter(([command]) => command === 'JSON.GET');
    expect(gets).toHaveLength(JSON_PAGE_SIZE);
  });

  it('does not show the start of a long string, only how long it is', async () => {
    const session = new FakeJsonSession({ long: 'x'.repeat(3000), short: 'yo' });
    const { nodes } = await readJsonChildren(session, key, '$', 0);
    expect(nodes[0]).toEqual({ path: '$["long"]', label: 'long', kind: 'string', size: 3000 });
    expect(nodes[1]).toMatchObject({ preview: 'yo' });
    // The long string was never fetched.
    expect(session.calls.some((words) => words[2] === '$["long"]' && words[0] === 'JSON.GET')).toBe(
      false,
    );
  });

  it('cuts a long value of a row', async () => {
    const session = new FakeJsonSession({ text: 'z'.repeat(1500) });
    const { nodes } = await readJsonChildren(session, key, '$', 0);
    const preview = nodes[0]?.preview ?? '';
    expect(preview.length).toBeLessThanOrEqual(120);
    expect(preview.endsWith('…')).toBe(true);
    expect(nodes[0]?.size).toBe(1500);
  });

  it('has no children for a scalar', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    expect(await readJsonChildren(session, key, '$["age"]', 0)).toEqual({
      nodes: [],
      total: 0,
      more: false,
    });
  });

  it('refuses a path that is gone and one that is not a path', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await expect(readJsonChildren(session, key, '$["nope"]', 0)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(readJsonChildren(session, key, 'age', 0)).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(
      readJsonChildren(session, key, `$${'['.repeat(MAX_JSON_PATH)}`, 0),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('readJsonText', () => {
  it('lays a part out for reading', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    expect((await readJsonText(session, key, '$["nested"]')).text).toBe(
      '{\n  "x": {\n    "y": 1\n  }\n}',
    );
    expect((await readJsonText(session, key, '$["name"]')).text).toBe('"Ann"');
    expect((await readJsonText(session, key, '$["tags"]')).text).toBe('["a", "b"]');
  });

  it('keeps a number as the server wrote it', async () => {
    const session = new FakeJsonSession({ n: 1 });
    await setJson(session, key, '$["n"]', '9007199254740993');
    expect((await readJsonText(session, key, '$["n"]')).text).toBe('9007199254740993');
  });

  it('leaves a part that is too big on the server', async () => {
    const session = new FakeJsonSession(DOCUMENT, { memory: MAX_JSON_READ_BYTES + 1 });
    const result = await readJsonText(session, key, '$');
    expect(result).toEqual({ text: '', tooLarge: MAX_JSON_READ_BYTES + 1 });
    expect(session.calls.some(([command]) => command === 'JSON.GET')).toBe(false);
  });

  it('reads a part of exactly the limit', async () => {
    const session = new FakeJsonSession(DOCUMENT, { memory: MAX_JSON_READ_BYTES });
    expect((await readJsonText(session, key, '$["name"]')).text).toBe('"Ann"');
  });

  it('reads a part when the server does not answer DEBUG', async () => {
    const session = new FakeJsonSession(DOCUMENT, { noDebug: true });
    expect((await readJsonText(session, key, '$["age"]')).text).toBe('30');
  });

  it('cuts text longer than the page takes', async () => {
    const session = new FakeJsonSession({ row: 'q'.repeat(MAX_JSON_TEXT + 10) });
    const result = await readJsonText(session, key, '$');
    expect(result.truncated).toBe(true);
    expect(result.text).toHaveLength(MAX_JSON_TEXT);
  });

  it('refuses a path that is gone', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await expect(readJsonText(session, key, '$["nope"]')).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(readJsonText(session, key, 'name')).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('setJson', () => {
  it('replaces the value at a path with the JSON written', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await setJson(session, key, '$["age"]', '31');
    await setJson(session, key, '$["tags"]', '[ "x" ,\n "y" ]');
    const written = session.calls.filter(([command]) => command === 'JSON.SET');
    // Compact, and only where a value is.
    expect(written[1]).toEqual(['JSON.SET', 'doc', '$["tags"]', '["x","y"]', 'XX']);
    expect(session.text()).toContain('"age":31');
    expect(session.text()).toContain('"tags":["x","y"]');
  });

  it('replaces the whole document at the root', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await setJson(session, key, '$', '{"fresh": true}');
    expect(session.text()).toBe('{"fresh":true}');
  });

  it('keeps numbers exact when it writes them', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await setJson(session, key, '$["ratio"]', '12345678901234567890.10');
    expect(session.calls.find(([command]) => command === 'JSON.SET')?.[3]).toBe(
      '12345678901234567890.10',
    );
  });

  it('refuses text that is not JSON', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await expect(setJson(session, key, '$["age"]', '{oops')).rejects.toMatchObject({
      code: 'syntax',
    });
    await expect(setJson(session, key, '$["age"]', '')).rejects.toMatchObject({ code: 'syntax' });
    await expect(setJson(session, key, '$["age"]', '1 2')).rejects.toMatchObject({
      code: 'syntax',
    });
    expect(session.calls.some(([command]) => command === 'JSON.SET')).toBe(false);
  });

  it('does not create a path that is gone', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await expect(setJson(session, key, '$["nope"]', '1')).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(session.text()).not.toContain('nope');
  });

  it('refuses a path that is not one', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await expect(setJson(session, key, 'age', '1')).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('deleteJson', () => {
  it('removes a member and an item', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await deleteJson(session, key, '$["age"]');
    await deleteJson(session, key, '$["tags"][0]');
    expect(session.text()).not.toContain('"age"');
    expect(session.text()).toContain('"tags":["b"]');
  });

  it('never removes the root: that is deleting the key', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await expect(deleteJson(session, key, '$')).rejects.toMatchObject({ code: 'unsupported' });
    expect(session.calls).toHaveLength(0);
  });

  it('says so when the path is already gone', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await expect(deleteJson(session, key, '$["nope"]')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses a path that is not one', async () => {
    const session = new FakeJsonSession(DOCUMENT);
    await expect(deleteJson(session, key, '.age')).rejects.toMatchObject({ code: 'unsupported' });
  });
});
