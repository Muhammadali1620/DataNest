import { describe, expect, it } from 'vitest';
import {
  fromHttpStatus,
  fluxQueryError,
  influxqlError,
  toInfluxDbError,
} from '../../../../src/drivers/influxdb/errors';
import type { FluxEvent } from '../../../../src/drivers/influxdb/flux-csv';
import { readInfluxql, readLines } from '../../../../src/drivers/influxdb/influxql';
import { influxqlCell, influxqlTypeName } from '../../../../src/drivers/influxdb/values';

async function* chunksOf(...parts: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    await Promise.resolve();
    yield typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
  }
}

async function events(...parts: (string | Buffer)[]): Promise<FluxEvent[]> {
  const found: FluxEvent[] = [];
  for await (const event of readInfluxql(chunksOf(...parts))) {
    found.push(event);
  }
  return found;
}

const SERIES = {
  results: [
    {
      statement_id: 0,
      series: [
        {
          name: 'cpu',
          columns: ['time', 'usage', 'host', 'up'],
          values: [
            ['2024-05-01T10:00:00Z', 1.5, 'a', true],
            ['2024-05-01T10:01:00Z', 2, null, false],
          ],
        },
      ],
    },
  ],
};

describe('readLines', () => {
  it('splits at line breaks and keeps a character cut between chunks whole', async () => {
    const bytes = Buffer.from('один\nдва\nтри', 'utf8');
    const lines: string[] = [];
    for await (const line of readLines(chunksOf(bytes.subarray(0, 3), bytes.subarray(3)))) {
      lines.push(line);
    }
    expect(lines).toEqual(['один', 'два', 'три']);
  });
});

describe('readInfluxql', () => {
  it('reads a series: columns with types, then rows with times as times', async () => {
    const found = await events(`${JSON.stringify(SERIES)}\n`);
    expect(found[0]).toEqual({
      kind: 'table',
      columns: [
        { name: 'time', dataType: 'dateTime' },
        { name: 'usage', dataType: 'float' },
        { name: 'host', dataType: 'string' },
        { name: 'up', dataType: 'boolean' },
      ],
    });
    expect(found[1]).toEqual({
      kind: 'row',
      cells: [{ kind: 'datetime', text: '2024-05-01T10:00:00Z' }, 1.5, 'a', true],
    });
    expect(found[2]).toEqual({
      kind: 'row',
      cells: [{ kind: 'datetime', text: '2024-05-01T10:01:00Z' }, 2, null, false],
    });
  });

  it('adds the tags of a GROUP BY series as columns after the others', async () => {
    const answer = {
      results: [
        {
          statement_id: 0,
          series: [
            {
              name: 'cpu',
              tags: { region: 'eu', host: 'a' },
              columns: ['time', 'mean'],
              values: [['2024-05-01T10:00:00Z', 3]],
            },
          ],
        },
      ],
    };
    const found = await events(`${JSON.stringify(answer)}\n`);
    expect(found[0]).toMatchObject({
      columns: [{ name: 'time' }, { name: 'mean' }, { name: 'host' }, { name: 'region' }],
    });
    expect(found[1]).toMatchObject({
      cells: [{ kind: 'datetime', text: '2024-05-01T10:00:00Z' }, 3, 'a', 'eu'],
    });
  });

  it('reads the documents of a chunked answer, one per line, however they are cut', async () => {
    const first = JSON.stringify({
      results: [
        {
          statement_id: 0,
          series: [{ name: 'm', columns: ['a'], values: [[1]], partial: true }],
          partial: true,
        },
      ],
    });
    const second = JSON.stringify({
      results: [{ statement_id: 0, series: [{ name: 'm', columns: ['a'], values: [[2]] }] }],
    });
    const text = `${first}\n${second}\n`;
    const found = await events(text.slice(0, 20), text.slice(20, 90), text.slice(90));
    const rows = found.filter((event) => event.kind === 'row');
    expect(rows).toEqual([
      { kind: 'row', cells: [1] },
      { kind: 'row', cells: [2] },
    ]);
  });

  it('reads nothing from a statement that returns no series', async () => {
    expect(await events('{"results":[{"statement_id":0}]}\n')).toEqual([]);
    expect(await events('')).toEqual([]);
    expect(await events('\n\n')).toEqual([]);
  });

  it('turns an error of a statement, or of the whole answer, into an error', async () => {
    await expect(
      events(
        '{"results":[{"statement_id":0,"error":"error parsing query: found FORM, expected FROM"}]}\n',
      ),
    ).rejects.toMatchObject({ code: 'syntax' });
    await expect(events('{"error":"database not found: \\"nope\\""}\n')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses an answer that is not JSON', async () => {
    await expect(events('<html>proxy</html>\n')).rejects.toMatchObject({ code: 'internal' });
  });

  it('skips documents of an unexpected shape', async () => {
    expect(await events('[1,2]\n{"results":[3,{"series":"x"}]}\n')).toEqual([]);
  });
});

describe('influxqlCell', () => {
  it('keeps numbers, booleans and null, and turns objects into JSON', () => {
    expect(influxqlCell(5, 'a')).toBe(5);
    expect(influxqlCell(true, 'a')).toBe(true);
    expect(influxqlCell(null, 'a')).toBeNull();
    expect(influxqlCell(undefined, 'a')).toBeNull();
    expect(influxqlCell({ x: 1 }, 'a')).toEqual({ kind: 'json', text: '{"x":1}' });
  });

  it('reads only the time column as a time, and only when it looks like one', () => {
    expect(influxqlCell('2024-05-01T10:00:00.5Z', 'time')).toEqual({
      kind: 'datetime',
      text: '2024-05-01T10:00:00.5Z',
    });
    expect(influxqlCell('2024-05-01T10:00:00Z', 'other')).toBe('2024-05-01T10:00:00Z');
    expect(influxqlCell('yesterday', 'time')).toBe('yesterday');
  });
});

describe('influxqlTypeName', () => {
  it('names the type from the first value', () => {
    expect(influxqlTypeName('time', '2024')).toBe('dateTime');
    expect(influxqlTypeName('a', 1)).toBe('integer');
    expect(influxqlTypeName('a', 1.5)).toBe('float');
    expect(influxqlTypeName('a', 'x')).toBe('string');
    expect(influxqlTypeName('a', false)).toBe('boolean');
    expect(influxqlTypeName('a', null)).toBeUndefined();
  });
});

describe('errors', () => {
  it('maps the status of the server', () => {
    expect(
      fromHttpStatus(401, '{"code":"unauthorized","message":"unauthorized access"}'),
    ).toMatchObject({
      code: 'auth-failed',
      message: 'unauthorized access',
    });
    expect(fromHttpStatus(403, '')).toMatchObject({ code: 'permission-denied' });
    expect(fromHttpStatus(404, '{"code":"not found","message":"bucket not found"}')).toMatchObject({
      code: 'not-found',
    });
    expect(fromHttpStatus(500, 'boom')).toMatchObject({ code: 'internal', message: 'boom' });
    expect(fromHttpStatus(503, '')).toMatchObject({ code: 'connection-failed' });
  });

  it('tells the kind of a failed query from its words', () => {
    const body = (message: string): string => JSON.stringify({ code: 'invalid', message });
    expect(
      fromHttpStatus(400, body('compilation failed: error @1:1-1:5: undefined identifier')),
    ).toMatchObject({ code: 'syntax' });
    expect(fromHttpStatus(400, body('query timeout: deadline exceeded'))).toMatchObject({
      code: 'timeout',
    });
    expect(fromHttpStatus(400, body('request canceled'))).toMatchObject({ code: 'cancelled' });
    expect(fromHttpStatus(400, body('permission denied for bucket'))).toMatchObject({
      code: 'permission-denied',
    });
    expect(fromHttpStatus(400, body('something odd'))).toMatchObject({ code: 'internal' });
  });

  it('reads the v1 form of an error, and a body that is not JSON', () => {
    expect(fromHttpStatus(400, '{"error":"error parsing query: found X"}')).toMatchObject({
      code: 'syntax',
      message: 'error parsing query: found X',
    });
    expect(fromHttpStatus(502, '<html>bad gateway</html>')).toMatchObject({
      message: '<html>bad gateway</html>',
    });
  });

  it('builds the errors of an answer that began well', () => {
    expect(fluxQueryError('', undefined)).toMatchObject({ code: 'internal' });
    expect(fluxQueryError('bucket "x" not found', '404')).toMatchObject({
      code: 'not-found',
      driverCode: '404',
    });
    expect(influxqlError('authorization failed')).toMatchObject({ code: 'auth-failed' });
  });

  it('separates a network failure from the rest', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(toInfluxDbError(refused)).toMatchObject({
      code: 'connection-failed',
      driverCode: 'ECONNREFUSED',
    });
    expect(toInfluxDbError(new Error('odd'))).toMatchObject({ code: 'internal' });
    const known = influxqlError('x');
    expect(toInfluxDbError(known)).toBe(known);
  });
});
