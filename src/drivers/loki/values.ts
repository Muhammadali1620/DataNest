// The answer of Loki's query API as rows (V13.25). A log query (`streams`) gives a row per line:
// its time, the exact nanosecond stamp, the labels of the stream as JSON, and the line. A metric
// query (`matrix`, `vector`, `scalar`) gives a row per sample: the time, the stamp, the value
// and the labels of the series. Streams arrive one after the other; the rows are merged by time.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { CellValue } from '../../shared/cell-value';
import type { ResultColumn } from '../driver';
import { isoOf, NS_PER_MS } from './time';

export type ResultKind = 'streams' | 'matrix' | 'vector' | 'scalar' | 'string';

export interface LokiRows {
  readonly kind: ResultKind;
  readonly columns: readonly ResultColumn[];
  readonly rows: CellValue[][];
  /** True when the answer held more rows than the caller asked for. */
  readonly more: boolean;
}

export const LOG_COLUMNS: readonly ResultColumn[] = [
  { name: 'time', dataType: 'datetime' },
  { name: 'ns', dataType: 'bigint' },
  { name: 'labels', dataType: 'json' },
  { name: 'line', dataType: 'text' },
];

export const SAMPLE_COLUMNS: readonly ResultColumn[] = [
  { name: 'time', dataType: 'datetime' },
  { name: 'ns', dataType: 'bigint' },
  { name: 'value', dataType: 'double' },
  { name: 'labels', dataType: 'json' },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The stamp of a metric sample: seconds with a fraction, as a JSON number. */
function sampleNs(seconds: unknown): bigint | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? BigInt(Math.round(seconds * 1000)) * NS_PER_MS
    : undefined;
}

function labelsCell(labels: Readonly<Record<string, unknown>>): CellValue {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(labels).sort()) {
    sorted[key] = labels[key];
  }
  return { kind: 'json', text: JSON.stringify(sorted) };
}

function nsCell(ns: bigint): CellValue {
  return { kind: 'bigint', text: ns.toString() };
}

function timeCell(ns: bigint): CellValue {
  return { kind: 'datetime', text: isoOf(ns) };
}

/** `"1.5"`, `"NaN"`, `"+Inf"` → a number. */
export function sampleValue(text: unknown): number {
  const value = String(text);
  if (value === '+Inf' || value === 'Inf') {
    return Number.POSITIVE_INFINITY;
  }
  if (value === '-Inf') {
    return Number.NEGATIVE_INFINITY;
  }
  return Number(value);
}

interface Entry {
  readonly ns: bigint;
  readonly cells: CellValue[];
}

function byTime(direction: 'forward' | 'backward'): (a: Entry, b: Entry) => number {
  const sign = direction === 'forward' ? 1 : -1;
  return (a, b) => (a.ns < b.ns ? -sign : a.ns > b.ns ? sign : 0);
}

function streamEntries(result: readonly unknown[]): Entry[] {
  const entries: Entry[] = [];
  for (const stream of result) {
    if (!isRecord(stream)) {
      continue;
    }
    const labels = isRecord(stream.stream) ? stream.stream : {};
    const values = Array.isArray(stream.values) ? (stream.values as unknown[]) : [];
    for (const value of values) {
      if (!Array.isArray(value) || typeof value[0] !== 'string' || !/^\d+$/u.test(value[0])) {
        continue;
      }
      const ns = BigInt(value[0]);
      // Loki 3 can name structured metadata and parsed labels beside the stream's own.
      const extra = isRecord(value[2]) ? value[2] : {};
      const merged = {
        ...labels,
        ...(isRecord(extra.structuredMetadata) ? extra.structuredMetadata : {}),
        ...(isRecord(extra.parsed) ? extra.parsed : {}),
      };
      entries.push({
        ns,
        cells: [timeCell(ns), nsCell(ns), labelsCell(merged), String(value[1] ?? '')],
      });
    }
  }
  return entries;
}

function sampleEntries(kind: ResultKind, result: unknown): Entry[] {
  const entries: Entry[] = [];
  const add = (labels: Readonly<Record<string, unknown>>, sample: unknown): void => {
    if (!Array.isArray(sample)) {
      return;
    }
    const ns = sampleNs(sample[0]);
    if (ns !== undefined) {
      entries.push({
        ns,
        cells: [timeCell(ns), nsCell(ns), sampleValue(sample[1]), labelsCell(labels)],
      });
    }
  };
  if (kind === 'scalar') {
    add({}, result);
    return entries;
  }
  for (const series of Array.isArray(result) ? (result as unknown[]) : []) {
    if (!isRecord(series)) {
      continue;
    }
    const labels = isRecord(series.metric) ? series.metric : {};
    if (kind === 'matrix') {
      for (const sample of Array.isArray(series.values) ? (series.values as unknown[]) : []) {
        add(labels, sample);
      }
    } else {
      add(labels, series.value);
    }
  }
  return entries;
}

/**
 * Reads the JSON of a successful answer, lines in one direction and samples of a metric in
 * another. At most `limit` rows are kept (after the first `skip`), the rest only counted as `more`.
 */
export function readAnswer(
  body: string,
  directions: { readonly lines: 'forward' | 'backward'; readonly samples: 'forward' | 'backward' },
  limit: number,
  skip = 0,
): LokiRows {
  let document: unknown;
  try {
    document = JSON.parse(body);
  } catch {
    throw new DbError('internal', msg('The server sent an answer that is not JSON'));
  }
  if (!isRecord(document)) {
    throw new DbError('internal', msg('The server sent an answer that is not JSON'));
  }
  if (document.status === 'error') {
    const text =
      typeof document.error === 'string'
        ? document.error
        : typeof document.errorType === 'string'
          ? document.errorType
          : 'The query failed on the server';
    throw new DbError('syntax', text);
  }
  const data = isRecord(document.data) ? document.data : {};
  const type = (typeof data.resultType === 'string' ? data.resultType : 'streams') as ResultKind;
  if (type === 'string') {
    const pair = Array.isArray(data.result) ? (data.result as unknown[]) : [];
    return {
      kind: 'string',
      columns: [{ name: 'value', dataType: 'text' }],
      rows: [[typeof pair[1] === 'string' ? pair[1] : '']],
      more: false,
    };
  }
  const entries =
    type === 'streams'
      ? streamEntries(Array.isArray(data.result) ? (data.result as unknown[]) : [])
      : sampleEntries(type, data.result);
  entries.sort(byTime(type === 'streams' ? directions.lines : directions.samples));
  const kept = entries.slice(skip, skip + limit);
  return {
    kind: type,
    columns: type === 'streams' ? LOG_COLUMNS : SAMPLE_COLUMNS,
    rows: kept.map((entry) => entry.cells),
    more: entries.length > skip + limit,
  };
}

/** What one message of the live view brings: new lines (oldest first) and how many Loki dropped. */
export interface TailBatch {
  readonly rows: CellValue[][];
  readonly dropped: number;
}

/** Reads a message of Loki's tail endpoint: `{"streams":[…],"dropped_entries":[…]}`. */
export function readTailMessage(text: string): TailBatch {
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new DbError('internal', msg('The server sent a message that is not JSON'));
  }
  if (!isRecord(document)) {
    throw new DbError('internal', msg('The server sent a message that is not JSON'));
  }
  const entries = streamEntries(
    Array.isArray(document.streams) ? (document.streams as unknown[]) : [],
  );
  entries.sort(byTime('forward'));
  return {
    rows: entries.map((entry) => entry.cells),
    dropped: Array.isArray(document.dropped_entries) ? document.dropped_entries.length : 0,
  };
}
