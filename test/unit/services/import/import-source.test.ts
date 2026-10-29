import { describe, expect, it } from 'vitest';
import {
  columnNames,
  formatOf,
  sampleSource,
  type SourceRecord,
  sourceRecords,
} from '../../../../src/services/import/import-source';
import type { ScriptChunk } from '../../../../src/services/script-runner';

async function* chunks(text: string, size = 5): AsyncGenerator<ScriptChunk> {
  for (let offset = 0; offset < text.length; offset += size) {
    await Promise.resolve();
    const piece = text.slice(offset, offset + size);
    yield { text: piece, bytes: piece.length };
  }
}

async function all(records: AsyncIterable<SourceRecord>): Promise<SourceRecord[]> {
  const found: SourceRecord[] = [];
  for await (const record of records) {
    found.push(record);
  }
  return found;
}

const CSV = { format: 'csv', delimiter: ',', header: true } as const;

describe('formatOf', () => {
  it('reads the format off the file name', () => {
    expect(formatOf('a.json')).toBe('json');
    expect(formatOf('a.NDJSON')).toBe('json');
    expect(formatOf('a.jsonl')).toBe('json');
    expect(formatOf('a.csv')).toBe('csv');
    expect(formatOf('data.txt')).toBe('csv');
  });
});

describe('columnNames', () => {
  it('numbers blanks and tells repeats apart', () => {
    expect(columnNames(['id', ' ', 'Name', 'name', 'id'])).toEqual([
      'id',
      'Column 2',
      'Name',
      'name_2',
      'id_2',
    ]);
  });
});

describe('sampleSource', () => {
  it('takes column names from a CSV header and leaves it out of the rows', async () => {
    const sample = await sampleSource(chunks('id,name\n1,Anna\n2,Bob\n3,Cid\n'), CSV, 2);
    expect(sample.columns).toEqual(['id', 'name']);
    expect(sample.records).toEqual([
      { line: 2, values: ['1', 'Anna'] },
      { line: 3, values: ['2', 'Bob'] },
    ]);
  });

  it('numbers the columns of a CSV without a header, as wide as the widest row', async () => {
    const sample = await sampleSource(chunks('1,a\n2,b,extra\n'), { ...CSV, header: false }, 10);
    expect(sample.columns).toEqual(['Column 1', 'Column 2', 'Column 3']);
    expect(sample.records).toHaveLength(2);
  });

  it('collects the keys of JSON records in the order they appear', async () => {
    const sample = await sampleSource(
      chunks('[{"id": 1}, {"name": "x", "id": 2}, 5]'),
      { ...CSV, format: 'json' },
      10,
    );
    expect(sample.columns).toEqual(['id', 'name']);
    expect(sample.records).toEqual([
      { line: 1, values: [{ number: '1' }, undefined] },
      { line: 1, values: [{ number: '2' }, 'x'] },
      { line: 1, error: 'A record must be an object' },
    ]);
  });
});

describe('sourceRecords', () => {
  it('gives every CSV record after the header and counts the bytes read', async () => {
    const seen: number[] = [];
    const records = await all(
      sourceRecords(chunks('id\n1\n2\n3\n'), CSV, ['id'], (bytes) => seen.push(bytes)),
    );
    expect(records.map((record) => ('values' in record ? record.values[0] : ''))).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(seen.at(-1)).toBe(9);
  });

  it('keeps the first CSV record when there is no header', async () => {
    const records = await all(sourceRecords(chunks('1\n2\n'), { ...CSV, header: false }, []));
    expect(records).toHaveLength(2);
  });

  it('puts JSON values in the order of the given columns', async () => {
    const records = await all(
      sourceRecords(chunks('{"b": 2, "a": 1}\n{"a": 3}'), { ...CSV, format: 'json' }, ['a', 'b']),
    );
    expect(records).toEqual([
      { line: 1, values: [{ number: '1' }, { number: '2' }] },
      { line: 2, values: [{ number: '3' }, undefined] },
    ]);
  });
});
