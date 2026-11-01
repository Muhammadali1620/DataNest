// The answer of InfluxQL (the v1 `/query` API, which InfluxDB 2.x serves for buckets that
// have a database/retention policy mapping). With `chunked=true` the server sends one JSON
// document per line as it has rows, so a long result is read as a stream.

import { StringDecoder } from 'node:string_decoder';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { CellValue } from '../../shared/cell-value';
import type { ResultColumn } from '../driver';
import { influxqlError } from './errors';
import type { FluxEvent } from './flux-csv';
import { influxqlCell, influxqlTypeName } from './values';

/** Splits a byte stream into lines without cutting a character in two. */
export async function* readLines(chunks: AsyncIterable<Buffer>): AsyncGenerator<string> {
  const decoder = new StringDecoder('utf8');
  let rest = '';
  for await (const chunk of chunks) {
    rest += decoder.write(chunk);
    let end = rest.indexOf('\n');
    while (end !== -1) {
      yield rest.slice(0, end);
      rest = rest.slice(end + 1);
      end = rest.indexOf('\n');
    }
  }
  rest += decoder.end();
  if (rest !== '') {
    yield rest;
  }
}

interface Series {
  readonly name?: unknown;
  readonly tags?: unknown;
  readonly columns?: unknown;
  readonly values?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the series of an InfluxQL answer as they arrive. */
export async function* readInfluxql(chunks: AsyncIterable<Buffer>): AsyncGenerator<FluxEvent> {
  for await (const line of readLines(chunks)) {
    if (line.trim() === '') {
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(line);
    } catch {
      throw new DbError('internal', msg('The server sent an answer that is not JSON'));
    }
    if (!isRecord(document)) {
      continue;
    }
    if (typeof document.error === 'string') {
      throw influxqlError(document.error);
    }
    const results = Array.isArray(document.results) ? (document.results as unknown[]) : [];
    for (const result of results) {
      if (!isRecord(result)) {
        continue;
      }
      if (typeof result.error === 'string') {
        throw influxqlError(result.error);
      }
      const series = Array.isArray(result.series) ? (result.series as Series[]) : [];
      for (const one of series) {
        yield* readSeries(one);
      }
    }
  }
}

function* readSeries(series: Series): Generator<FluxEvent> {
  const names = Array.isArray(series.columns) ? (series.columns as unknown[]).map(String) : [];
  const tags = isRecord(series.tags) ? series.tags : {};
  const tagKeys = Object.keys(tags).sort();
  const values = Array.isArray(series.values) ? (series.values as unknown[]) : [];
  const firstRow = Array.isArray(values[0]) ? (values[0] as unknown[]) : [];
  const columns: ResultColumn[] = [
    ...names.map((name, index) => {
      const dataType = influxqlTypeName(name, firstRow[index]);
      return dataType === undefined ? { name } : { name, dataType };
    }),
    // A series of GROUP BY tag carries the tag values beside its columns.
    ...tagKeys.map((name) => ({ name, dataType: 'tag' })),
  ];
  yield { kind: 'table', columns };
  const tail: CellValue[] = tagKeys.map((key) => influxqlCell(tags[key], key));
  for (const row of values) {
    if (!Array.isArray(row)) {
      continue;
    }
    yield {
      kind: 'row',
      cells: [...names.map((name, index) => influxqlCell(row[index], name)), ...tail],
    };
  }
}
