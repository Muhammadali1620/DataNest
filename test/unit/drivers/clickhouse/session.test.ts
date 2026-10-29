import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import type { PeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import {
  agentFor,
  clientUrl,
  HTTPS_PORT,
  JsonRows,
  OUTPUT_SETTINGS,
  requestSettings,
  RESULT_FORMAT,
  returnsRows,
  ROW_BATCH_SIZE,
  TextRows,
  usedDatabase,
} from '../../../../src/drivers/clickhouse/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';

const config: ResolvedConnectionConfig = {
  id: 'c',
  name: 'n',
  driver: 'clickhouse',
  host: 'db.example',
  user: 'app',
};

const EXCEPTION =
  "Code: 395. DB::Exception: too far: while executing 'FUNCTION throwIf(…)'. (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO) (version 25.8.33.6 (official build))";

function lines(...text: string[]): Buffer {
  return Buffer.from(`${text.join('\n')}\n`);
}

describe('returnsRows', () => {
  it.each([
    'SELECT 1',
    ' with x AS (SELECT 1) SELECT * FROM x',
    'SHOW TABLES',
    'DESCRIBE t',
    'DESC t',
    'EXISTS t',
    'EXPLAIN SELECT 1',
    '-- note\nSELECT 1',
  ])('reads rows from %s', (sql) => {
    expect(returnsRows(sql)).toBe(true);
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'CREATE TABLE t (a UInt8) ENGINE = Memory',
    'ALTER TABLE t DELETE WHERE 1',
    'USE shop',
    'SET max_threads = 1',
    'OPTIMIZE TABLE t',
    '',
  ])('runs %s to its end', (sql) => {
    expect(returnsRows(sql)).toBe(false);
  });
});

describe('requestSettings', () => {
  it('asks for the result format for rows, and waits for the end of a write', () => {
    expect(requestSettings(true, undefined)).toEqual({
      session_timeout: 3600,
      default_format: RESULT_FORMAT,
    });
    expect(requestSettings(false, undefined)).toEqual({
      session_timeout: 3600,
      wait_end_of_query: 1,
    });
  });

  it('sends the database with the request, but not an empty one', () => {
    expect(requestSettings(true, 'shop')).toMatchObject({ database: 'shop' });
    expect(requestSettings(true, '')).not.toHaveProperty('database');
  });

  it('keeps 64-bit numbers and decimals exact in every result', () => {
    expect(OUTPUT_SETTINGS).toMatchObject({
      output_format_json_quote_64bit_integers: 1,
      output_format_json_quote_decimals: 1,
      output_format_json_quote_denormals: 1,
      output_format_decimal_trailing_zeros: 1,
    });
  });
});

describe('usedDatabase', () => {
  it('reads the database USE switches to, quoted or not', () => {
    expect(usedDatabase('USE shop')).toBe('shop');
    expect(usedDatabase('  use shop ;  ')).toBe('shop');
    expect(usedDatabase('USE `my db`')).toBe('my db');
    expect(usedDatabase('USE `a\\`b`')).toBe('a`b');
    expect(usedDatabase('USE "x.y"')).toBe('x.y');
  });

  it('is undefined for anything else', () => {
    expect(usedDatabase('SELECT 1')).toBeUndefined();
    expect(usedDatabase('USE')).toBeUndefined();
    expect(usedDatabase('USE a b')).toBeUndefined();
    expect(usedDatabase('USER x')).toBeUndefined();
  });
});

describe('clientUrl', () => {
  it('takes HTTP on 8123, or HTTPS on 8443 with TLS, when no port is given', () => {
    expect(clientUrl(config, undefined)).toBe('http://db.example:8123');
    expect(clientUrl(config, { mode: 'require', serverName: 'db.example' })).toBe(
      `https://db.example:${HTTPS_PORT}`,
    );
  });

  it('keeps a given port and puts brackets around IPv6 addresses', () => {
    expect(clientUrl({ ...config, port: 7123 }, undefined)).toBe('http://db.example:7123');
    expect(clientUrl({ ...config, host: '::1' }, undefined)).toBe('http://[::1]:8123');
    expect(clientUrl({ ...config, host: '[::1]' }, undefined)).toBe('http://[::1]:8123');
    expect(clientUrl({ ...config, host: undefined }, undefined)).toBe('http://localhost:8123');
  });
});

describe('agentFor', () => {
  interface Options {
    keepAlive?: boolean;
    rejectUnauthorized?: boolean;
    servername?: string;
    ca?: unknown;
    checkServerIdentity?: (host: string, cert: PeerCertificate) => Error | undefined;
  }
  const options = (agent: HttpAgent | HttpsAgent): Options =>
    (agent as unknown as { options: Options }).options;

  it('keeps plain HTTP connections alive', () => {
    const agent = agentFor(undefined);
    expect(agent).toBeInstanceOf(HttpAgent);
    expect(agent).not.toBeInstanceOf(HttpsAgent);
    expect(options(agent).keepAlive).toBe(true);
  });

  it('encrypts without checks in require', () => {
    const agent = agentFor({ mode: 'require', serverName: 'db.example' });
    expect(agent).toBeInstanceOf(HttpsAgent);
    expect(options(agent).rejectUnauthorized).toBe(false);
  });

  it('checks the chain in verify-ca with the given CA, and the name only in verify-full', () => {
    const ca = Buffer.from('CA');
    const verifyCa = options(agentFor({ mode: 'verify-ca', serverName: 'db.example', ca }));
    expect(verifyCa.rejectUnauthorized).toBe(true);
    expect(verifyCa.ca).toBe(ca);
    expect(verifyCa.checkServerIdentity?.('x', {} as PeerCertificate)).toBeUndefined();
    const full = options(agentFor({ mode: 'verify-full', serverName: 'db.example', ca }));
    const other = { subject: { CN: 'other' }, subjectaltname: 'DNS:other' } as PeerCertificate;
    expect(full.checkServerIdentity?.('x', other)).toBeInstanceOf(Error);
  });

  it('sends SNI for host names only', () => {
    expect(options(agentFor({ mode: 'require', serverName: 'db.example' })).servername).toBe(
      'db.example',
    );
    expect(options(agentFor({ mode: 'require', serverName: '10.0.0.5' }))).not.toHaveProperty(
      'servername',
    );
  });
});

describe('JsonRows', () => {
  it('reads names and types as columns, then rows by their types', () => {
    const reader = new JsonRows();
    const events = reader.push(
      lines(
        '["id", "big", "price"]',
        '["UInt32", "UInt64", "Nullable(Decimal(6, 2))"]',
        '[1, "18446744073709551615", "12.50"]',
        '[2, "3", null]',
      ),
    );
    expect(events).toEqual([
      {
        kind: 'columns',
        columns: [
          { name: 'id', dataType: 'UInt32' },
          { name: 'big', dataType: 'UInt64' },
          { name: 'price', dataType: 'Nullable(Decimal(6, 2))' },
        ],
      },
      {
        kind: 'rows',
        rows: [
          [1, { kind: 'bigint', text: '18446744073709551615' }, { kind: 'decimal', text: '12.50' }],
          [2, 3, null],
        ],
      },
    ]);
    expect(reader.end()).toEqual([]);
  });

  it('names unnamed columns', () => {
    const events = new JsonRows().push(lines('["", "x"]', '["UInt8", "UInt8"]'));
    expect(events[0]).toEqual({
      kind: 'columns',
      columns: [
        { name: 'column1', dataType: 'UInt8' },
        { name: 'x', dataType: 'UInt8' },
      ],
    });
  });

  it('reads lines and characters cut between chunks', () => {
    const reader = new JsonRows();
    const body = lines('["name"]', '["String"]', '["日本語"]', '["🚀"]');
    const events = [];
    // One byte at a time cuts every line and every multibyte character.
    for (let index = 0; index < body.length; index++) {
      events.push(...reader.push(body.subarray(index, index + 1)));
    }
    events.push(...reader.end());
    const rows = events.flatMap((event) => (event.kind === 'rows' ? event.rows : []));
    expect(rows).toEqual([['日本語'], ['🚀']]);
  });

  it('reads a last line that has no newline at the end', () => {
    const reader = new JsonRows();
    expect(reader.push(Buffer.from('["n"]\n["UInt8"]\n[5]'))).toHaveLength(1);
    expect(reader.end()).toEqual([{ kind: 'rows', rows: [[5]] }]);
  });

  it('cuts rows into batches', () => {
    const rows = Array.from({ length: ROW_BATCH_SIZE + 1 }, (_, index) => `[${index}]`);
    const events = new JsonRows().push(lines('["n"]', '["UInt32"]', ...rows));
    expect(events.map((event) => (event.kind === 'rows' ? event.rows.length : 0))).toEqual([
      0,
      ROW_BATCH_SIZE,
      1,
    ]);
  });

  it('throws the error the server writes after the first rows, with its name and number', () => {
    const reader = new JsonRows();
    reader.push(lines('["x"]', '["UInt8"]', '[0]'));
    let thrown: unknown;
    try {
      reader.push(lines(JSON.stringify([EXCEPTION])));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({
      message: expect.stringMatching(/^too far: while executing/u) as unknown,
      type: 'FUNCTION_THROW_IF_VALUE_IS_NON_ZERO',
      code: '395',
    });
  });

  it('throws an error written as a plain line too', () => {
    const reader = new JsonRows();
    expect(() => reader.push(lines(EXCEPTION))).toThrow(/^too far/u);
  });

  it('keeps a value that only starts like an error', () => {
    const reader = new JsonRows();
    const events = reader.push(
      lines('["s"]', '["String"]', '["Code: 1. DB::Exception: just text"]'),
    );
    expect(events.at(-1)).toEqual({ kind: 'rows', rows: [['Code: 1. DB::Exception: just text']] });
  });

  it('skips blank lines', () => {
    const events = new JsonRows().push(Buffer.from('["n"]\n\n["UInt8"]\n  \n[1]\n'));
    expect(events.at(-1)).toEqual({ kind: 'rows', rows: [[1]] });
  });
});

describe('TextRows', () => {
  it('shows a format the statement asked for as lines of one column named after it', () => {
    const reader = new TextRows('CSV');
    expect(reader.push(Buffer.from('1,"a"\n2,'))).toEqual([
      { kind: 'columns', columns: [{ name: 'CSV' }] },
      { kind: 'rows', rows: [['1,"a"']] },
    ]);
    expect(reader.end()).toEqual([{ kind: 'rows', rows: [['2,']] }]);
  });

  it('sends the column once even before any line, and nothing for an empty body', () => {
    const reader = new TextRows('TSV');
    expect(reader.push(Buffer.from(''))).toEqual([{ kind: 'columns', columns: [{ name: 'TSV' }] }]);
    expect(reader.end()).toEqual([]);
  });

  it('throws an error that arrives in the middle', () => {
    const reader = new TextRows('CSV');
    reader.push(Buffer.from('1\n'));
    expect(() => reader.push(lines(EXCEPTION))).toThrow(/too far/u);
  });
});
