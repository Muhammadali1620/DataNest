import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  readCsvRecords,
  readFlux,
  type FluxEvent,
} from '../../../../src/drivers/influxdb/flux-csv';
import { fluxCell, fluxTypeName } from '../../../../src/drivers/influxdb/values';

async function* chunksOf(...parts: (string | Buffer)[]): AsyncGenerator<Buffer> {
  for (const part of parts) {
    await Promise.resolve();
    yield typeof part === 'string' ? Buffer.from(part, 'utf8') : part;
  }
}

async function records(...parts: (string | Buffer)[]): Promise<string[][]> {
  const found: string[][] = [];
  for await (const record of readCsvRecords(chunksOf(...parts))) {
    found.push(record);
  }
  return found;
}

async function events(...parts: (string | Buffer)[]): Promise<FluxEvent[]> {
  const found: FluxEvent[] = [];
  for await (const event of readFlux(chunksOf(...parts))) {
    found.push(event);
  }
  return found;
}

describe('readCsvRecords', () => {
  it('cuts records at line breaks, with LF or CRLF', async () => {
    expect(await records('a,b\r\nc,d\n')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ]);
  });

  it('gives a blank line as an empty record and keeps empty fields', async () => {
    expect(await records('a,,c\n\n,\n')).toEqual([['a', '', 'c'], [], ['', '']]);
  });

  it('reads quotes: commas, doubled quotes and line breaks inside a field', async () => {
    expect(await records('"a,b","say ""hi""","x\r\ny"\n')).toEqual([['a,b', 'say "hi"', 'x\r\ny']]);
  });

  it('ends the last record without a final line break', async () => {
    expect(await records('a,b')).toEqual([['a', 'b']]);
    expect(await records('a,"b"')).toEqual([['a', 'b']]);
  });

  it('copes with a quote pair cut between two chunks', async () => {
    expect(await records('"a"', '"b",c\n')).toEqual([['a"b', 'c']]);
    expect(await records('"a"', ',c\n')).toEqual([['a', 'c']]);
  });

  it('does not cut a multi-byte character that arrives in two chunks', async () => {
    const bytes = Buffer.from('ключ,значение\n', 'utf8');
    expect(await records(bytes.subarray(0, 3), bytes.subarray(3))).toEqual([['ключ', 'значение']]);
  });

  it('reads nothing from an empty answer', async () => {
    expect(await records()).toEqual([]);
    expect(await records('')).toEqual([]);
  });
});

const ANSWER = [
  '#datatype,string,long,dateTime:RFC3339,double,string,string',
  '#group,false,false,false,false,true,true',
  '#default,_result,,,,,',
  ',result,table,_time,_value,_field,host',
  ',,0,2024-05-01T10:00:00Z,1.5,usage,a',
  ',,0,2024-05-01T10:01:00Z,2,usage,a',
  '',
  '#datatype,string,long,dateTime:RFC3339,double,string,string',
  '#default,_result,,,,,',
  ',result,table,_time,_value,_field,host',
  ',,1,2024-05-01T10:00:00Z,,usage,b',
  '',
  '',
].join('\r\n');

describe('readFlux', () => {
  it('reads the tables of an answer: columns with their types, then the rows', async () => {
    const found = await events(ANSWER);
    expect(found[0]).toEqual({
      kind: 'table',
      columns: [
        { name: 'table', dataType: 'long' },
        { name: '_time', dataType: 'dateTime' },
        { name: '_value', dataType: 'double' },
        { name: '_field', dataType: 'string' },
        { name: 'host', dataType: 'string' },
      ],
    });
    expect(found[1]).toEqual({
      kind: 'row',
      cells: [0, { kind: 'datetime', text: '2024-05-01T10:00:00Z' }, 1.5, 'usage', 'a'],
    });
    expect(found[2]).toEqual({
      kind: 'row',
      cells: [0, { kind: 'datetime', text: '2024-05-01T10:01:00Z' }, 2, 'usage', 'a'],
    });
    expect(found[3]?.kind).toBe('table');
    expect(found[4]).toEqual({
      kind: 'row',
      cells: [1, { kind: 'datetime', text: '2024-05-01T10:00:00Z' }, null, 'usage', 'b'],
    });
    expect(found).toHaveLength(5);
  });

  it('gives the same events however the bytes are cut', async () => {
    const whole = await events(ANSWER);
    const bytes = Buffer.from(ANSWER, 'utf8');
    const pieces: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += 7) {
      pieces.push(bytes.subarray(at, at + 7));
    }
    expect(await events(...pieces)).toEqual(whole);
  });

  it('keeps the result column when the query names its result', async () => {
    const found = await events(
      '#datatype,string,long,double\r\n#default,,,\r\n,result,table,_value\r\n,mine,0,3\r\n\r\n',
    );
    expect(found[0]).toEqual({
      kind: 'table',
      columns: [
        { name: 'result', dataType: 'string' },
        { name: 'table', dataType: 'long' },
        { name: '_value', dataType: 'double' },
      ],
    });
    expect(found[1]).toEqual({ kind: 'row', cells: ['mine', 0, 3] });
  });

  it('fills a column from its #default when the cell is empty', async () => {
    const found = await events(
      '#datatype,string,long,string\r\n#default,_result,,none\r\n,result,table,tag\r\n,,0,\r\n,,0,x\r\n\r\n',
    );
    expect(found.slice(1)).toEqual([
      { kind: 'row', cells: [0, 'none'] },
      { kind: 'row', cells: [0, 'x'] },
    ]);
  });

  it('reads an answer without annotations as text, and keeps the result column', async () => {
    const found = await events(',result,table,_value\r\n,,0,5\r\n\r\n');
    expect(found).toEqual([
      { kind: 'table', columns: [{ name: 'result' }, { name: 'table' }, { name: '_value' }] },
      { kind: 'row', cells: [null, '0', '5'] },
    ]);
  });

  it('turns an error table into an error with the message of the server', async () => {
    const answer =
      ',error,reference\r\n,"compilation failed: error @1:1-1:3: undefined identifier x",897\r\n\r\n';
    await expect(events(answer)).rejects.toMatchObject({
      name: 'DbError',
      code: 'syntax',
      message: 'compilation failed: error @1:1-1:3: undefined identifier x',
      driverCode: '897',
    });
    await expect(events(answer)).rejects.toBeInstanceOf(DbError);
  });

  it('reads nothing from an empty answer', async () => {
    expect(await events('')).toEqual([]);
  });
});

describe('fluxCell', () => {
  it('reads integers, keeping the ones too big for a double as text', () => {
    expect(fluxCell('42', 'long', undefined)).toBe(42);
    expect(fluxCell('-7', 'long', undefined)).toBe(-7);
    expect(fluxCell('9007199254740993', 'long', undefined)).toEqual({
      kind: 'bigint',
      text: '9007199254740993',
    });
    expect(fluxCell('18446744073709551615', 'unsignedLong', undefined)).toEqual({
      kind: 'bigint',
      text: '18446744073709551615',
    });
  });

  it('reads doubles with their special values', () => {
    expect(fluxCell('1.25', 'double', undefined)).toBe(1.25);
    expect(fluxCell('1e3', 'double', undefined)).toBe(1000);
    expect(fluxCell('+Inf', 'double', undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(fluxCell('-Inf', 'double', undefined)).toBe(Number.NEGATIVE_INFINITY);
    expect(fluxCell('NaN', 'double', undefined)).toBeNaN();
    expect(fluxCell('weird', 'double', undefined)).toBe('weird');
  });

  it('reads booleans, times, durations and binary', () => {
    expect(fluxCell('true', 'boolean', undefined)).toBe(true);
    expect(fluxCell('false', 'boolean', undefined)).toBe(false);
    expect(fluxCell('maybe', 'boolean', undefined)).toBe('maybe');
    expect(fluxCell('2024-05-01T10:00:00.123456789Z', 'dateTime:RFC3339Nano', undefined)).toEqual({
      kind: 'datetime',
      text: '2024-05-01T10:00:00.123456789Z',
    });
    expect(fluxCell('1h30m', 'duration', undefined)).toBe('1h30m');
    expect(fluxCell(Buffer.from([1, 2, 3]).toString('base64'), 'base64Binary', undefined)).toEqual({
      kind: 'binary',
      size: 3,
      preview: '010203',
    });
  });

  it('treats empty as null, unless the column has a default', () => {
    expect(fluxCell('', 'long', undefined)).toBeNull();
    expect(fluxCell('', 'string', '')).toBeNull();
    expect(fluxCell('', 'string', 'n/a')).toBe('n/a');
    expect(fluxCell('x', 'string', 'n/a')).toBe('x');
  });

  it('reads text when the type is not known', () => {
    expect(fluxCell('5', undefined, undefined)).toBe('5');
    expect(fluxCell('5', 'somethingNew', undefined)).toBe('5');
  });
});

describe('fluxTypeName', () => {
  it('shortens the time types and passes the rest', () => {
    expect(fluxTypeName('dateTime:RFC3339')).toBe('dateTime');
    expect(fluxTypeName('long')).toBe('long');
    expect(fluxTypeName('')).toBeUndefined();
    expect(fluxTypeName(undefined)).toBeUndefined();
  });
});
