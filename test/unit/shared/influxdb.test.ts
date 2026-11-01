import { describe, expect, it } from 'vitest';
import { isReadOnlyStatement } from '../../../src/core/sql/read-only';
import { syntaxOf, tokenize, textOf } from '../../../src/core/sql/tokenizer';
import { keywordsOf } from '../../../src/core/sql/keywords';
import { functionsOf } from '../../../src/core/sql/functions';
import { snippetsOf } from '../../../src/core/sql/snippets';
import { isSystemDatabase } from '../../../src/core/model/system-objects';
import { parseConnectionUrl } from '../../../src/shared/connection-url';
import {
  DEFAULT_PORTS,
  driverFamily,
  filterSupport,
  isSqlDriver,
  optionSupport,
} from '../../../src/shared/connection';
import { dbMarkFile } from '../../../src/shared/db-marks';

const FLUX = syntaxOf('influxdb');

describe('InfluxDB in the shared tables', () => {
  it('is a SQL-family driver with its own port', () => {
    expect(isSqlDriver('influxdb')).toBe(true);
    expect(driverFamily('influxdb')).toBe('sql');
    expect(DEFAULT_PORTS.influxdb).toBe(8086);
  });

  it('supports a connect timeout, TLS and a query timeout, but no session statements', () => {
    expect(optionSupport('influxdb')).toEqual({
      connectTimeout: true,
      keepAlive: false,
      timeZone: false,
      charset: false,
      tls: true,
      queryTimeout: true,
      init: false,
    });
  });

  it('filters databases (buckets) but not schemas', () => {
    expect(filterSupport('influxdb')).toEqual({ databases: true, schemas: false });
  });

  it('hides the buckets the server keeps for itself', () => {
    expect(isSystemDatabase('influxdb', '_monitoring')).toBe(true);
    expect(isSystemDatabase('influxdb', '_tasks')).toBe(true);
    expect(isSystemDatabase('influxdb', 'metrics')).toBe(false);
  });

  it('completes InfluxQL words, Flux functions and snippets', () => {
    expect(keywordsOf('influxdb')).toContain('GROUP BY');
    expect(functionsOf('influxdb').map((fn) => fn.name)).toEqual(
      expect.arrayContaining(['MEAN', 'aggregateWindow', 'filter', 'range']),
    );
    expect(snippetsOf('influxdb').map((snippet) => snippet.prefix)).toEqual(
      expect.arrayContaining(['last1h', 'window', 'influxql']),
    );
  });

  it('has its own mark, in four states', () => {
    expect(dbMarkFile('influxdb', 'on')).toBe('influxdb-on.svg');
    expect(dbMarkFile('influxdb', 'error')).toBe('influxdb-error.svg');
  });
});

describe('tokenizing Flux and InfluxQL', () => {
  it('reads // as a comment to the end of the line', () => {
    const sql = '// it\'s a note\nfrom(bucket: "b")';
    const comment = tokenize(sql, FLUX)[0];
    expect(comment?.kind).toBe('comment');
    expect(textOf(sql, comment as never)).toBe("// it's a note");
  });

  it('leaves // alone in other dialects', () => {
    expect(tokenize('// x', syntaxOf('mysql'))[0]?.kind).not.toBe('comment');
  });

  it('keeps "…" as a quoted name and reads a backslash escape in a string', () => {
    const sql = `SELECT "my field" FROM m WHERE host = 'it\\'s'`;
    const kinds = tokenize(sql, FLUX)
      .filter((token) => token.kind !== 'whitespace')
      .map((token) => token.kind);
    expect(kinds).toContain('quoted-identifier');
    expect(kinds.filter((kind) => kind === 'string')).toHaveLength(1);
  });
});

describe('which statements only read', () => {
  it('lets Flux queries and imports through', () => {
    expect(isReadOnlyStatement('from(bucket: "b") |> range(start: -1h)', FLUX)).toBe(true);
    expect(
      isReadOnlyStatement('// note\nfrom(bucket: "b") |> range(start: -1h) |> mean()', FLUX),
    ).toBe(true);
    expect(
      isReadOnlyStatement(
        'import "influxdata/influxdb/schema"\nschema.measurements(bucket: "b")',
        FLUX,
      ),
    ).toBe(true);
  });

  it('refuses Flux that writes or sends data away', () => {
    expect(
      isReadOnlyStatement('from(bucket: "a") |> range(start: -1h) |> to(bucket: "b")', FLUX),
    ).toBe(false);
    expect(
      isReadOnlyStatement(
        'import "http"\nfrom(bucket: "a") |> range(start: -1h) |> map(fn: (r) => ({r with s: http.post(url: "x")}))',
        FLUX,
      ),
    ).toBe(false);
    expect(
      isReadOnlyStatement(
        'import "influxdata/influxdb/tasks"\nfrom(bucket: "a") |> range(start: -1h) |> delete()',
        FLUX,
      ),
    ).toBe(false);
  });

  it('keeps InfluxQL as it was: SELECT and SHOW read, DROP and DELETE do not', () => {
    expect(isReadOnlyStatement('SELECT * FROM "cpu" LIMIT 5', FLUX)).toBe(true);
    expect(isReadOnlyStatement('SHOW MEASUREMENTS', FLUX)).toBe(true);
    expect(isReadOnlyStatement('SELECT * INTO "copy" FROM "cpu"', FLUX)).toBe(false);
    expect(isReadOnlyStatement('DROP MEASUREMENT "cpu"', FLUX)).toBe(false);
    expect(isReadOnlyStatement('DELETE FROM "cpu"', FLUX)).toBe(false);
  });
});

describe('an InfluxDB address', () => {
  it('reads host, port, bucket, organization and token', () => {
    const parsed = parseConnectionUrl('influxdb://db.example.com:8087/metrics?org=acme&token=abc');
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        input: {
          driver: 'influxdb',
          host: 'db.example.com',
          port: 8087,
          database: 'metrics',
          user: 'acme',
        },
        password: 'abc',
      },
    });
    expect(parsed.ok && parsed.value.input.ssl).toBeUndefined();
  });

  it('turns TLS on for influxdbs:// or tls=1', () => {
    for (const address of ['influxdbs://h/metrics', 'influxdb://h/metrics?tls=1']) {
      const parsed = parseConnectionUrl(address);
      expect(parsed.ok && parsed.value.input.ssl).toEqual({ mode: 'verify-full' });
    }
  });

  it('takes the organization from the user part and the bucket from the query', () => {
    const parsed = parseConnectionUrl('influxdb://acme:tok@h?bucket=b');
    expect(parsed).toMatchObject({
      ok: true,
      value: { input: { user: 'acme', database: 'b' }, password: 'tok' },
    });
  });

  it('asks for a host, and ignores port 0', () => {
    expect(parseConnectionUrl('influxdb:///metrics')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseConnectionUrl('influxdb://h:99999/b')).toEqual({ ok: false, problem: 'not-a-url' });
    const zero = parseConnectionUrl('influxdb://h:0/b');
    expect(zero.ok && zero.value.input.port).toBeUndefined();
  });
});
