// The answer of Flux: "annotated CSV" (the format InfluxDB 2.x documents for /api/v2/query).
// Several tables follow each other in one answer, each with `#datatype` / `#group` /
// `#default` lines, a header row, rows and a blank line. Read as a stream: records are cut
// from the bytes as they arrive, so memory stays small however many points come back.

import { StringDecoder } from 'node:string_decoder';
import type { CellValue } from '../../shared/cell-value';
import type { ResultColumn } from '../driver';
import { fluxQueryError } from './errors';
import { fluxCell, fluxTypeName } from './values';

/** Cuts CSV records (RFC 4180: quotes, `""`, line breaks inside quotes); a blank line is `[]`. */
export async function* readCsvRecords(chunks: AsyncIterable<Buffer>): AsyncGenerator<string[]> {
  const decoder = new StringDecoder('utf8');
  let record: string[] = [];
  let field = '';
  let started = false;
  let inQuotes = false;
  let quoteSeen = false;

  // A function, so the checker sees that `feed` changes it.
  function hasPending(): boolean {
    return started;
  }

  function* feed(text: string): Generator<string[]> {
    for (const char of text) {
      if (inQuotes) {
        if (quoteSeen) {
          quoteSeen = false;
          if (char === '"') {
            field += '"';
            continue;
          }
          inQuotes = false;
        } else if (char === '"') {
          quoteSeen = true;
          continue;
        } else {
          field += char;
          continue;
        }
      }
      if (char === '"' && field === '') {
        inQuotes = true;
        started = true;
      } else if (char === ',') {
        record.push(field);
        field = '';
        started = true;
      } else if (char === '\n') {
        if (started) {
          record.push(field);
          yield record;
        } else {
          yield [];
        }
        record = [];
        field = '';
        started = false;
      } else if (char !== '\r') {
        field += char;
        started = true;
      }
    }
  }

  for await (const chunk of chunks) {
    yield* feed(decoder.write(chunk));
  }
  yield* feed(decoder.end());
  if (hasPending()) {
    record.push(field);
    yield record;
  }
}

export type FluxEvent =
  /** A table begins: its columns, in the order the cells will follow. */
  | { readonly kind: 'table'; readonly columns: readonly ResultColumn[] }
  | { readonly kind: 'row'; readonly cells: readonly CellValue[] };

/** Columns that carry no data: the annotation column and the name of the result. */
const HIDDEN = new Set(['result']);

/** Reads the tables of a Flux answer as they arrive. */
export async function* readFlux(chunks: AsyncIterable<Buffer>): AsyncGenerator<FluxEvent> {
  let annotations = new Map<string, readonly string[]>();
  let header: readonly string[] | undefined;
  let keep: number[] = [];
  let types: readonly string[] = [];
  let defaults: readonly string[] = [];
  let errorTable = false;
  for await (const record of readCsvRecords(chunks)) {
    if (record.length === 0) {
      // A blank line ends the table; the next one brings its own annotations.
      header = undefined;
      errorTable = false;
      annotations = new Map();
      continue;
    }
    const first = record[0] ?? '';
    if (first.startsWith('#')) {
      annotations.set(first.slice(1).toLowerCase(), record);
      continue;
    }
    if (header === undefined) {
      header = record;
      if (record[1] === 'error' && record[2] === 'reference') {
        errorTable = true;
        continue;
      }
      types = annotations.get('datatype') ?? [];
      defaults = annotations.get('default') ?? [];
      keep = [];
      const columns: ResultColumn[] = [];
      for (let index = 1; index < record.length; index++) {
        const name = record[index] ?? '';
        if (HIDDEN.has(name) && (defaults[index] ?? '') !== '') {
          continue;
        }
        keep.push(index);
        columns.push({ name, dataType: fluxTypeName(types[index]) });
      }
      yield { kind: 'table', columns };
      continue;
    }
    if (errorTable) {
      // A failed query inside a 200 answer: the table's one row holds the message.
      throw fluxQueryError(record[1] ?? '', record[2]);
    }
    if (record.length === 1 && header.length > 1 && first === '') {
      continue;
    }
    yield {
      kind: 'row',
      cells: keep.map((index) => fluxCell(record[index] ?? '', types[index], defaults[index])),
    };
  }
}
