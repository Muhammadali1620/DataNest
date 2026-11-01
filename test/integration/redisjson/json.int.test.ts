import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver } from '../../../src/drivers/redis';
import type { RedisSession } from '../../../src/drivers/redis-driver';
import {
  deleteJson,
  itemPath,
  JSON_PAGE_SIZE,
  MAX_JSON_READ_BYTES,
  memberPath,
  readJsonChildren,
  readJsonRoot,
  readJsonText,
  setJson,
} from '../../../src/services/redis/key-json';
import { replyText } from '../../../src/services/redis/reply';
import { redisKeyRef } from '../../../src/shared/redis-key';
import { RedisKeyModel } from '../../../src/vscode/panels/redis-key-model';
import { TEST_REDISJSON } from '../../helpers/redis-servers';

// docker/compose.yml `redisjson` (V13.14): a Redis Stack server with the RedisJSON module.
let session: RedisSession;
const KEY = new TextEncoder().encode('it:json:doc');
const BIG = new TextEncoder().encode('it:json:big');
const LIST = new TextEncoder().encode('it:json:list');

const DOCUMENT = `{"name":"Ann","age":30,"pi":3.10,"big":9007199254740993,"ok":true,"none":null,
"tags":["a","b"],"nested":{"x":{"y":1}},"we\\"ird\\\\key":1,"sp ace":2,"ключ":3,"empty":{},"none2":[]}`;

async function put(key: Uint8Array, text: string): Promise<void> {
  await session.call(['JSON.SET', key, '$', text]);
}

beforeAll(async () => {
  session = await driver.openSession({
    id: 'it',
    name: 'it',
    driver: 'redis',
    host: TEST_REDISJSON.host,
    port: TEST_REDISJSON.port,
  });
});

afterAll(async () => {
  await session.call(['DEL', KEY, BIG, LIST]);
  await session.close();
});

describe('RedisJSON keys', () => {
  it('reads the root: kind and size', async () => {
    await put(KEY, DOCUMENT);
    expect(replyText(await session.call(['TYPE', KEY]))).toBe('ReJSON-RL');
    expect(await readJsonRoot(session, KEY)).toEqual({
      path: '$',
      label: '$',
      kind: 'object',
      size: 13,
    });
  });

  it('lists the members of an object with kinds, sizes and values', async () => {
    await put(KEY, DOCUMENT);
    const { nodes, total, more } = await readJsonChildren(session, KEY, '$', 0);
    expect(total).toBe(13);
    expect(more).toBe(false);
    const byLabel = Object.fromEntries(nodes.map((node) => [node.label, node]));
    expect(byLabel.name).toEqual({
      path: '$["name"]',
      label: 'name',
      kind: 'string',
      size: 3,
      preview: 'Ann',
    });
    expect(byLabel.age).toMatchObject({ kind: 'integer', preview: '30' });
    expect(byLabel.pi).toMatchObject({ kind: 'number' });
    // 64-bit integers come as the server wrote them, not rounded by a double.
    expect(byLabel.big).toMatchObject({ kind: 'integer', preview: '9007199254740993' });
    expect(byLabel.ok).toMatchObject({ kind: 'boolean', preview: 'true' });
    expect(byLabel.none).toMatchObject({ kind: 'null', preview: 'null' });
    expect(byLabel.tags).toEqual({ path: '$["tags"]', label: 'tags', kind: 'array', size: 2 });
    expect(byLabel.nested).toMatchObject({ kind: 'object', size: 1 });
    expect(byLabel.empty).toMatchObject({ kind: 'object', size: 0 });
    expect(byLabel.none2).toMatchObject({ kind: 'array', size: 0 });
  });

  it('opens the nodes it listed, whatever their names (quotes, backslashes, spaces, Cyrillic)', async () => {
    await put(KEY, DOCUMENT);
    const { nodes } = await readJsonChildren(session, KEY, '$', 0);
    for (const node of nodes) {
      const own = await readJsonChildren(session, KEY, node.path, 0);
      expect(own.total).toBe(
        node.kind === 'object' || node.kind === 'array' ? (node.size ?? 0) : 0,
      );
    }
    const odd = nodes.find((node) => node.label === 'we"ird\\key');
    expect(odd).toMatchObject({ kind: 'integer', preview: '1' });
    expect(memberPath('$', 'we"ird\\key')).toBe(odd?.path);
    const nested = await readJsonChildren(session, KEY, memberPath('$', 'nested'), 0);
    expect(nested.nodes.map((node) => node.path)).toEqual(['$["nested"]["x"]']);
  });

  it('lists the items of an array by position', async () => {
    await put(KEY, DOCUMENT);
    const { nodes, total } = await readJsonChildren(session, KEY, '$["tags"]', 0);
    expect(total).toBe(2);
    expect(nodes).toEqual([
      { path: '$["tags"][0]', label: '0', kind: 'string', size: 1, preview: 'a' },
      { path: '$["tags"][1]', label: '1', kind: 'string', size: 1, preview: 'b' },
    ]);
    expect(itemPath('$["tags"]', 1)).toBe('$["tags"][1]');
  });

  it('pages a big array and a big object, and says when there is more', async () => {
    const count = JSON_PAGE_SIZE * 2 + 17;
    await put(LIST, JSON.stringify(Array.from({ length: count }, (_, index) => index)));
    const first = await readJsonChildren(session, LIST, '$', 0);
    expect(first.nodes).toHaveLength(JSON_PAGE_SIZE);
    expect(first.more).toBe(true);
    expect(first.total).toBe(count);
    const last = await readJsonChildren(session, LIST, '$', JSON_PAGE_SIZE * 2);
    expect(last.nodes.map((node) => node.label)).toEqual(
      Array.from({ length: 17 }, (_, index) => String(JSON_PAGE_SIZE * 2 + index)),
    );
    expect(last.more).toBe(false);
    const object = Object.fromEntries(
      Array.from({ length: count }, (_, index) => [`k${String(index)}`, index]),
    );
    await put(LIST, JSON.stringify(object));
    const members = await readJsonChildren(session, LIST, '$', JSON_PAGE_SIZE);
    expect(members.nodes).toHaveLength(JSON_PAGE_SIZE);
    expect(members.nodes[0]?.label).toBe(`k${String(JSON_PAGE_SIZE)}`);
    expect(members.more).toBe(true);
  });

  it('shows the length of a long string, not its start', async () => {
    await put(BIG, JSON.stringify({ long: 'x'.repeat(5000), short: 'hi' }));
    const { nodes } = await readJsonChildren(session, BIG, '$', 0);
    expect(nodes.find((node) => node.label === 'long')).toEqual({
      path: '$["long"]',
      label: 'long',
      kind: 'string',
      size: 5000,
    });
    expect(nodes.find((node) => node.label === 'short')?.preview).toBe('hi');
  });

  it('has no children for a scalar, and refuses a path that is gone', async () => {
    await put(KEY, DOCUMENT);
    expect(await readJsonChildren(session, KEY, '$["age"]', 0)).toEqual({
      nodes: [],
      total: 0,
      more: false,
    });
    await expect(readJsonChildren(session, KEY, '$["nope"]', 0)).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(readJsonChildren(session, KEY, 'age', 0)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('lays out a part of the document, keeping numbers as the server stores them', async () => {
    await put(KEY, DOCUMENT);
    const whole = await readJsonText(session, KEY, '$');
    expect(whole.truncated).toBeUndefined();
    expect(whole.text).toContain('"big": 9007199254740993');
    expect(whole.text).toContain('"tags": ["a", "b"]');
    expect((await readJsonText(session, KEY, '$["nested"]')).text).toBe(
      '{\n  "x": {\n    "y": 1\n  }\n}',
    );
    expect((await readJsonText(session, KEY, '$["name"]')).text).toBe('"Ann"');
  });

  it('does not read a part that is too big to read whole', async () => {
    const piece = 'y'.repeat(1000);
    await put(BIG, JSON.stringify({ rows: Array.from({ length: 5000 }, () => piece) }));
    const result = await readJsonText(session, BIG, '$');
    expect(result.tooLarge).toBeGreaterThan(MAX_JSON_READ_BYTES);
    expect(result.text).toBe('');
    // A part of it is small enough.
    expect((await readJsonText(session, BIG, '$["rows"][0]')).text).toBe(`"${piece}"`);
  });

  it('replaces a value at a path, and refuses text that is not JSON or a path that is gone', async () => {
    await put(KEY, DOCUMENT);
    await setJson(session, KEY, '$["age"]', '31');
    await setJson(session, KEY, '$["tags"]', '[ "x" ,\n"y", {"z": 1.50} ]');
    expect((await readJsonText(session, KEY, '$["age"]')).text).toBe('31');
    expect(replyText(await session.call(['JSON.GET', KEY, '$["tags"]']))).toBe(
      '[["x","y",{"z":1.5}]]',
    );
    await expect(setJson(session, KEY, '$["age"]', '{oops')).rejects.toMatchObject({
      code: 'syntax',
    });
    // Nothing is created by mistake.
    await expect(setJson(session, KEY, '$["missing"]', '1')).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(replyText(await session.call(['JSON.TYPE', KEY, '$["missing"]']))).toBe('');
  });

  it('removes a member or an item, never the root', async () => {
    await put(KEY, DOCUMENT);
    await deleteJson(session, KEY, '$["age"]');
    await deleteJson(session, KEY, '$["tags"][0]');
    const { nodes } = await readJsonChildren(session, KEY, '$', 0);
    expect(nodes.some((node) => node.label === 'age')).toBe(false);
    expect((await readJsonText(session, KEY, '$["tags"]')).text).toBe('["b"]');
    await expect(deleteJson(session, KEY, '$["age"]')).rejects.toMatchObject({ code: 'not-found' });
    await expect(deleteJson(session, KEY, '$')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('feeds the key page: the root in the state, a change by path, no items', async () => {
    await put(KEY, DOCUMENT);
    const model = new RedisKeyModel({
      key: redisKeyRef(KEY),
      database: 0,
      connectionName: 'it',
      readOnly: false,
      session: () => Promise.resolve(session),
    });
    const state = await model.refresh();
    expect(state.type).toBe('ReJSON-RL');
    expect(state.json).toMatchObject({ path: '$', kind: 'object', size: 13 });
    expect(state.items).toBeUndefined();
    expect(state.jsonError).toBeUndefined();
    const changed = await model.apply({
      kind: 'jsonSet',
      path: '$["nested"]',
      text: '{"a":1,"b":2}',
    });
    expect(changed.json?.size).toBe(13);
    expect((await model.jsonChildren('$["nested"]', 0)).total).toBe(2);
    const afterDelete = await model.apply({ kind: 'jsonDelete', path: '$["nested"]' });
    expect(afterDelete.json?.size).toBe(12);
  });
});
