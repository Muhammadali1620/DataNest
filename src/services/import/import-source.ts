// The records of a CSV or JSON file as rows of fields in a fixed column order (V5.3),
// read in parts so the file can be of any size. The same reader serves the preview
// (the first records) and the import itself (all of them).

import type { ScriptChunk } from '../script-runner';
import { type CsvDelimiter, CsvParser, type CsvRecord } from './csv-parser';
import type { SourceValue } from './import-values';
import { type JsonRecord, JsonRecordParser } from './json-parser';

export type ImportFormat = 'csv' | 'json';

export interface SourceOptions {
  readonly format: ImportFormat;
  /** CSV only. */
  readonly delimiter: CsvDelimiter;
  /** CSV only: the first record holds the column names. */
  readonly header: boolean;
}

export type SourceRecord =
  | { readonly line: number; readonly values: readonly SourceValue[] }
  | { readonly line: number; readonly error: string };

export interface SourceSample {
  /** Names of the file's columns: the CSV header, `Column N`, or the keys of JSON records. */
  readonly columns: string[];
  readonly records: SourceRecord[];
}

/** The format a file name suggests. */
export function formatOf(fileName: string): ImportFormat {
  return /\.(json|jsonl|ndjson)$/iu.test(fileName) ? 'json' : 'csv';
}

/** Names that can stand in a list: blanks get a number, repeats a suffix. */
export function columnNames(raw: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((name, index) => {
    const base = name.trim() === '' ? `Column ${index + 1}` : name.trim();
    const count = (seen.get(base.toLowerCase()) ?? 0) + 1;
    seen.set(base.toLowerCase(), count);
    return count === 1 ? base : `${base}_${count}`;
  });
}

/** Reads up to `limit` records and the columns they show. */
export async function sampleSource(
  chunks: AsyncIterable<ScriptChunk>,
  options: SourceOptions,
  limit: number,
): Promise<SourceSample> {
  if (options.format === 'csv') {
    const raw: CsvRecord[] = [];
    for await (const record of csvRecords(chunks, options.delimiter)) {
      raw.push(record);
      if (raw.length > limit) {
        break;
      }
    }
    const [first, ...rest] = raw;
    const data = options.header ? rest : raw;
    const width = Math.max(
      options.header ? (first?.fields.length ?? 0) : 0,
      ...data.map((record) => record.fields.length),
    );
    const header = options.header && first !== undefined ? first.fields : [];
    const columns = columnNames(Array.from({ length: width }, (_, index) => header[index] ?? ''));
    return {
      columns,
      records: data.slice(0, limit).map((record) => ({ line: record.line, values: record.fields })),
    };
  }
  const raw: JsonRecord[] = [];
  for await (const record of jsonRecords(chunks)) {
    raw.push(record);
    if (raw.length >= limit) {
      break;
    }
  }
  const keys: string[] = [];
  for (const record of raw) {
    if (record.ok) {
      for (const key of record.fields.keys()) {
        if (!keys.includes(key)) {
          keys.push(key);
        }
      }
    }
  }
  return { columns: keys, records: raw.map((record) => jsonRow(record, keys)) };
}

/** Every record, as values in the order of `columns`, and the bytes read before it. */
export async function* sourceRecords(
  chunks: AsyncIterable<ScriptChunk>,
  options: SourceOptions,
  columns: readonly string[],
  onBytes?: (bytes: number) => void,
): AsyncGenerator<SourceRecord> {
  const counted = countBytes(chunks, onBytes);
  if (options.format === 'csv') {
    let first = true;
    for await (const record of csvRecords(counted, options.delimiter)) {
      if (first && options.header) {
        first = false;
        continue;
      }
      first = false;
      yield { line: record.line, values: record.fields };
    }
    return;
  }
  for await (const record of jsonRecords(counted)) {
    yield jsonRow(record, columns);
  }
}

function jsonRow(record: JsonRecord, columns: readonly string[]): SourceRecord {
  if (!record.ok) {
    return { line: record.line, error: record.error };
  }
  return { line: record.line, values: columns.map((column) => record.fields.get(column)) };
}

async function* countBytes(
  chunks: AsyncIterable<ScriptChunk>,
  onBytes: ((bytes: number) => void) | undefined,
): AsyncGenerator<ScriptChunk> {
  let bytes = 0;
  for await (const chunk of chunks) {
    yield chunk;
    bytes += chunk.bytes;
    onBytes?.(bytes);
  }
}

async function* csvRecords(
  chunks: AsyncIterable<ScriptChunk>,
  delimiter: CsvDelimiter,
): AsyncGenerator<CsvRecord> {
  const parser = new CsvParser(delimiter);
  for await (const chunk of chunks) {
    yield* parser.push(chunk.text);
  }
  yield* parser.end();
}

async function* jsonRecords(chunks: AsyncIterable<ScriptChunk>): AsyncGenerator<JsonRecord> {
  const parser = new JsonRecordParser();
  for await (const chunk of chunks) {
    yield* parser.push(chunk.text);
  }
  yield* parser.end();
}
