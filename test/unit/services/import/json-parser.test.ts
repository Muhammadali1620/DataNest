import { describe, expect, it } from 'vitest';
import {
  type JsonRecord,
  JsonRecordParser,
  parseRecord,
} from '../../../../src/services/import/json-parser';

function read(text: string, size = text.length || 1): JsonRecord[] {
  const parser = new JsonRecordParser();
  const records: JsonRecord[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    records.push(...parser.push(text.slice(offset, offset + size)));
  }
  return [...records, ...parser.end()];
}

function stable(text: string): JsonRecord[] {
  const whole = read(text);
  for (const size of [1, 2, 3, 7]) {
    expect(read(text, size), `parts of ${size}`).toEqual(whole);
  }
  return whole;
}

function fields(record: JsonRecord | undefined): Record<string, unknown> {
  if (!record?.ok) {
    throw new Error(`Not a record: ${JSON.stringify(record)}`);
  }
  return Object.fromEntries(record.fields);
}

describe('JsonRecordParser', () => {
  it('reads an array of objects with the line each starts on', () => {
    const records = stable('[\n  {"id": 1, "name": "Anna"},\n  {"id": 2, "name": null}\n]\n');
    expect(records.map((record) => record.line)).toEqual([2, 3]);
    expect(fields(records[0])).toEqual({ id: { number: '1' }, name: 'Anna' });
    expect(fields(records[1])).toEqual({ id: { number: '2' }, name: null });
  });

  it('reads JSON Lines', () => {
    const records = stable('{"a": true}\n{"a": false}\n\n{"a": "x"}');
    expect(records.map((record) => fields(record).a)).toEqual([true, false, 'x']);
    expect(records.map((record) => record.line)).toEqual([1, 2, 4]);
  });

  it('keeps numbers as the file writes them', () => {
    const record = fields(stable('[{"big": 12345678901234567890, "money": 0.10, "e": 1e5}]')[0]);
    expect(record).toEqual({
      big: { number: '12345678901234567890' },
      money: { number: '0.10' },
      e: { number: '1e5' },
    });
  });

  it('turns nested values into JSON text, numbers kept', () => {
    const record = fields(stable('[{"tags": ["a", {"n": 0.10}], "o": {}}]')[0]);
    expect(record).toEqual({ tags: { json: '["a",{"n":0.10}]' }, o: { json: '{}' } });
  });

  it('is not misled by braces, brackets and quotes inside strings', () => {
    const record = fields(stable('[{"s": "a}b]c\\"{", "t": "\\\\"}]')[0]);
    expect(record).toEqual({ s: 'a}b]c"{', t: '\\' });
  });

  it('reports a record that is not an object and goes on', () => {
    const records = stable('[1, "x", [2], {"a": 1}]');
    expect(records.map((record) => record.ok)).toEqual([false, false, false, true]);
    expect(records[0]).toMatchObject({ ok: false, error: 'A record must be an object' });
  });

  it('reports a broken record, an unclosed array and text after the array', () => {
    expect(read('{"a": 1,}\n{"a": 2}').map((record) => record.ok)).toEqual([false, true]);
    expect(read('[{"a": 1}')).toEqual([
      { line: 1, ok: true, fields: new Map([['a', { number: '1' }]]) },
      { line: 1, ok: false, error: 'The array is never closed' },
    ]);
    expect(read('[{"a": 1}] {"b": 2}').map((record) => record.ok)).toEqual([true, false, true]);
    expect(read('{"a": ').at(-1)).toMatchObject({
      ok: false,
      error: 'The file ends inside a record',
    });
  });

  it('gives nothing for empty text and an empty array', () => {
    expect(stable('')).toEqual([]);
    expect(stable(' [ ] ')).toEqual([]);
  });
});

describe('parseRecord', () => {
  it('says why text is not a record', () => {
    expect(parseRecord('[1]')).toBe('A record must be an object');
    expect(typeof parseRecord('{')).toBe('string');
  });
});
