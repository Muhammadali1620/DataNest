import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  LOG_COLUMNS,
  readAnswer,
  SAMPLE_COLUMNS,
  sampleValue,
} from '../../../../src/drivers/loki/values';
import { matrix, streams, vector } from '../../../helpers/fake-loki';

const BACK = { lines: 'backward', samples: 'forward' } as const;
const FORWARD = { lines: 'forward', samples: 'forward' } as const;

const T1 = '1730000000000000001';
const T2 = '1730000000000000002';
const T3 = '1730000000000000003';

describe('readAnswer: log lines', () => {
  const body = streams([
    {
      labels: { app: 'shop', level: 'info' },
      lines: [
        [T1, 'first'],
        [T3, 'third'],
      ],
    },
    { labels: { app: 'api' }, lines: [[T2, 'second']] },
  ]);

  it('makes a row of each line: time, exact stamp, labels as JSON, the line', () => {
    const answer = readAnswer(body, BACK, 10);
    expect(answer.kind).toBe('streams');
    expect(answer.columns).toBe(LOG_COLUMNS);
    expect(answer.rows[0]).toEqual([
      { kind: 'datetime', text: '2024-10-27T03:33:20.000Z' },
      { kind: 'bigint', text: T3 },
      { kind: 'json', text: '{"app":"shop","level":"info"}' },
      'third',
    ]);
  });

  it('merges the streams by time, newest first when asked backward', () => {
    expect(readAnswer(body, BACK, 10).rows.map((row) => row[3])).toEqual([
      'third',
      'second',
      'first',
    ]);
  });

  it('merges them oldest first when asked forward', () => {
    expect(readAnswer(body, FORWARD, 10).rows.map((row) => row[3])).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('keeps the stamp exact beyond what a double holds', () => {
    const rows = readAnswer(body, FORWARD, 10).rows;
    expect(rows.map((row) => (row[1] as { text: string }).text)).toEqual([T1, T2, T3]);
  });

  it('cuts at the limit and says there was more', () => {
    const answer = readAnswer(body, FORWARD, 2);
    expect(answer.rows.map((row) => row[3])).toEqual(['first', 'second']);
    expect(answer.more).toBe(true);
    expect(readAnswer(body, FORWARD, 3).more).toBe(false);
  });

  it('skips the lines of the earlier pages', () => {
    const answer = readAnswer(body, FORWARD, 2, 1);
    expect(answer.rows.map((row) => row[3])).toEqual(['second', 'third']);
    expect(answer.more).toBe(false);
  });

  it('sorts the labels, so the same stream always reads the same', () => {
    const answer = readAnswer(
      streams([{ labels: { z: '1', a: '2', m: '3' }, lines: [[T1, 'x']] }]),
      BACK,
      5,
    );
    expect(answer.rows[0]?.[2]).toEqual({ kind: 'json', text: '{"a":"2","m":"3","z":"1"}' });
  });

  it('adds structured metadata and parsed labels beside the labels of the stream', () => {
    const answer = readAnswer(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'streams',
          result: [
            {
              stream: { app: 'shop' },
              values: [
                [T1, 'line', { structuredMetadata: { trace: 't1' }, parsed: { level: 'warn' } }],
              ],
            },
          ],
        },
      }),
      BACK,
      5,
    );
    expect(answer.rows[0]?.[2]).toEqual({
      kind: 'json',
      text: '{"app":"shop","level":"warn","trace":"t1"}',
    });
  });

  it('keeps an empty line and a line of unusual text', () => {
    const answer = readAnswer(
      streams([
        {
          labels: { a: 'b' },
          lines: [
            [T1, ''],
            [T2, 'tab\there "quoted" ünï \u{1F600}'],
          ],
        },
      ]),
      FORWARD,
      5,
    );
    expect(answer.rows.map((row) => row[3])).toEqual(['', 'tab\there "quoted" ünï \u{1F600}']);
  });

  it('skips entries that are not [stamp, line] pairs', () => {
    const answer = readAnswer(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'streams',
          result: [
            { stream: {}, values: [['x', 'bad'], 'bad', [T1, 'good'], [12, 'bad']] },
            'bad',
            { stream: {} },
          ],
        },
      }),
      FORWARD,
      5,
    );
    expect(answer.rows.map((row) => row[3])).toEqual(['good']);
  });

  it('reads an empty result as no rows', () => {
    const answer = readAnswer(streams([]), BACK, 5);
    expect(answer.rows).toEqual([]);
    expect(answer.more).toBe(false);
    expect(answer.columns).toBe(LOG_COLUMNS);
  });
});

describe('readAnswer: metrics', () => {
  it('makes a row of each sample of a matrix, oldest first', () => {
    const answer = readAnswer(
      matrix([
        {
          metric: { app: 'shop' },
          values: [
            [1730000060, '2'],
            [1730000000, '1.5'],
          ],
        },
        { metric: { app: 'api' }, values: [[1730000030, '7']] },
      ]),
      BACK,
      10,
    );
    expect(answer.kind).toBe('matrix');
    expect(answer.columns).toBe(SAMPLE_COLUMNS);
    expect(answer.rows.map((row) => row[2])).toEqual([1.5, 7, 2]);
    expect(answer.rows[0]).toEqual([
      { kind: 'datetime', text: '2024-10-27T03:33:20.000Z' },
      { kind: 'bigint', text: '1730000000000000000' },
      1.5,
      { kind: 'json', text: '{"app":"shop"}' },
    ]);
  });

  it('reverses the samples when asked backward', () => {
    const answer = readAnswer(
      matrix([
        {
          metric: {},
          values: [
            [1730000000, '1'],
            [1730000060, '2'],
          ],
        },
      ]),
      { lines: 'forward', samples: 'backward' },
      10,
    );
    expect(answer.rows.map((row) => row[2])).toEqual([2, 1]);
  });

  it('reads a vector as one row per series', () => {
    const answer = readAnswer(
      vector([
        { metric: { app: 'shop' }, value: [1730000000.5, '3'] },
        { metric: {}, value: [1730000000.5, '4'] },
      ]),
      BACK,
      10,
    );
    expect(answer.kind).toBe('vector');
    expect(answer.rows.map((row) => row[2])).toEqual([3, 4]);
    expect(answer.rows[0]?.[1]).toEqual({ kind: 'bigint', text: '1730000000500000000' });
  });

  it('reads a scalar', () => {
    const answer = readAnswer(
      JSON.stringify({
        status: 'success',
        data: { resultType: 'scalar', result: [1730000000, '42'] },
      }),
      BACK,
      10,
    );
    expect(answer.rows.map((row) => row[2])).toEqual([42]);
  });

  it('reads a string result', () => {
    const answer = readAnswer(
      JSON.stringify({ status: 'success', data: { resultType: 'string', result: [1, 'hi'] } }),
      BACK,
      10,
    );
    expect(answer.rows).toEqual([['hi']]);
  });

  it('reads the words a sample can hold', () => {
    expect(sampleValue('1.5')).toBe(1.5);
    expect(sampleValue('+Inf')).toBe(Number.POSITIVE_INFINITY);
    expect(sampleValue('Inf')).toBe(Number.POSITIVE_INFINITY);
    expect(sampleValue('-Inf')).toBe(Number.NEGATIVE_INFINITY);
    expect(sampleValue('NaN')).toBeNaN();
  });

  it('skips a sample without a usable time', () => {
    const answer = readAnswer(
      JSON.stringify({
        status: 'success',
        data: {
          resultType: 'matrix',
          result: [{ metric: {}, values: [['x', '1'], [1730000000, '2'], 'bad'] }, 'bad'],
        },
      }),
      BACK,
      10,
    );
    expect(answer.rows.map((row) => row[2])).toEqual([2]);
  });
});

describe('readAnswer: failures', () => {
  it('refuses what is not JSON', () => {
    expect(() => readAnswer('<html>', BACK, 1)).toThrow(DbError);
    expect(() => readAnswer('<html>', BACK, 1)).toThrow(/not JSON/u);
    expect(() => readAnswer('[1]', BACK, 1)).toThrow(/not JSON/u);
    expect(() => readAnswer('"x"', BACK, 1)).toThrow(/not JSON/u);
  });

  it('turns an error status in the document into an error', () => {
    expect(() =>
      readAnswer(JSON.stringify({ status: 'error', error: 'bad query' }), BACK, 1),
    ).toThrow('bad query');
    expect(() =>
      readAnswer(JSON.stringify({ status: 'error', errorType: 'timeout' }), BACK, 1),
    ).toThrow('timeout');
  });

  it('reads a document without data as no rows', () => {
    expect(readAnswer(JSON.stringify({ status: 'success' }), BACK, 1).rows).toEqual([]);
  });
});
