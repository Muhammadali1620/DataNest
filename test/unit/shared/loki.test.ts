import { describe, expect, it } from 'vitest';
import { isSystemDatabase } from '../../../src/core/model/system-objects';
import { functionsOf } from '../../../src/core/sql/functions';
import { keywordsOf } from '../../../src/core/sql/keywords';
import { isReadOnlyStatement } from '../../../src/core/sql/read-only';
import { snippetsOf } from '../../../src/core/sql/snippets';
import { syntaxOf, textOf, tokenize } from '../../../src/core/sql/tokenizer';
import { splitStatements } from '../../../src/core/sql/split';
import { identifierProblem } from '../../../src/core/sql/identifiers';
import { parseConnectionUrl } from '../../../src/shared/connection-url';
import {
  DEFAULT_PORTS,
  driverFamily,
  filterSupport,
  isSqlDriver,
  optionSupport,
} from '../../../src/shared/connection';
import { dbMarkFile } from '../../../src/shared/db-marks';
import { hasAccounts } from '../../../src/services/users/account-list';
import { sectionsFor } from '../../../src/vscode/panels/manager-model';

const LOGQL = syntaxOf('loki');

describe('Loki in the shared tables', () => {
  it('is a SQL-family driver with its own port', () => {
    expect(isSqlDriver('loki')).toBe(true);
    expect(driverFamily('loki')).toBe('sql');
    expect(DEFAULT_PORTS.loki).toBe(3100);
  });

  it('supports a connect timeout, TLS, a query timeout and init statements', () => {
    expect(optionSupport('loki')).toEqual({
      connectTimeout: true,
      keepAlive: false,
      timeZone: false,
      charset: false,
      tls: true,
      queryTimeout: true,
      init: true,
    });
  });

  it('has no databases or schemas to filter, no system objects, no accounts, no manager', () => {
    expect(filterSupport('loki')).toEqual({ databases: false, schemas: false });
    expect(isSystemDatabase('loki', 'anything')).toBe(false);
    expect(hasAccounts('loki')).toBe(false);
    expect(sectionsFor('loki')).toEqual([]);
  });

  it('accepts any label name', () => {
    expect(identifierProblem('app', 'loki')).toBeUndefined();
    expect(identifierProblem('x'.repeat(500), 'loki')).toBeUndefined();
  });

  it('completes LogQL words, functions and snippets', () => {
    expect(keywordsOf('loki')).toEqual(expect.arrayContaining(['by', 'without', 'line_format']));
    expect(functionsOf('loki').map((fn) => fn.name)).toEqual(
      expect.arrayContaining(['rate', 'count_over_time', 'quantile_over_time', 'topk']),
    );
    expect(snippetsOf('loki').map((snippet) => snippet.prefix)).toEqual(
      expect.arrayContaining(['last1h', 'errors', 'rate', 'json']),
    );
  });

  it('has its own mark, in four states', () => {
    expect(dbMarkFile('loki', 'on')).toBe('loki-on.svg');
    expect(dbMarkFile('loki', 'off')).toBe('loki-off.svg');
    expect(dbMarkFile('loki', 'error')).toBe('loki-error.svg');
    expect(dbMarkFile('loki', 'on')).not.toBe(dbMarkFile('influxdb', 'on'));
  });
});

describe('tokenizing LogQL', () => {
  function kinds(sql: string): string[] {
    return tokenize(sql, LOGQL)
      .filter((token) => token.kind !== 'whitespace')
      .map((token) => token.kind);
  }

  it('reads # as a comment to the end of the line', () => {
    const sql = '# range: 1h\n{app="x"}';
    const first = tokenize(sql, LOGQL)[0];
    expect(first?.kind).toBe('comment');
    expect(textOf(sql, first as never)).toBe('# range: 1h');
  });

  it('reads "…" as a string with backslash escapes', () => {
    const sql = '{app="a\\"b"} |= "x"';
    expect(kinds(sql).filter((kind) => kind === 'string')).toHaveLength(2);
  });

  it('reads a raw string in backticks whole', () => {
    const sql = '{app="x"} |~ `\\d+ "quoted" # not a comment`';
    const tokens = tokenize(sql, LOGQL).filter((token) => token.kind !== 'whitespace');
    expect(tokens.at(-1)?.kind).toBe('quoted-identifier');
    expect(tokens.filter((token) => token.kind === 'comment')).toHaveLength(0);
  });

  it('does not take -- for a comment, or // either', () => {
    expect(kinds('a -- b').includes('comment')).toBe(false);
    expect(kinds('a // b').includes('comment')).toBe(false);
  });

  it('keeps a # inside a string out of the comments', () => {
    expect(kinds('{a="# no"}').includes('comment')).toBe(false);
  });

  it('splits statements at semicolons like any other', () => {
    expect(splitStatements('{a="b"}; {c="d"}').map((part) => part.text.trim())).toEqual([
      '{a="b"}',
      '{c="d"}',
    ]);
  });
});

describe('which statements only read', () => {
  it('says every LogQL statement reads: the query API cannot write', () => {
    for (const sql of [
      '{app="shop"}',
      '# range: 1h\n{app="shop"} |= "error"',
      'sum by (app) (rate({app="shop"}[5m]))',
      '{app="x"} | json | line_format "{{.msg}}"',
      '',
      '# only a note',
      'DELETE {x}',
    ]) {
      expect(isReadOnlyStatement(sql, LOGQL), sql).toBe(true);
    }
  });
});

describe('a Loki address', () => {
  it('reads host, port, tenant and token', () => {
    const parsed = parseConnectionUrl('loki://logs.example.com:3101?tenant=acme&token=abc');
    expect(parsed).toMatchObject({
      ok: true,
      value: {
        input: { driver: 'loki', host: 'logs.example.com', port: 3101, database: 'acme' },
        password: 'abc',
      },
    });
    expect(parsed.ok && parsed.value.input.user).toBeUndefined();
    expect(parsed.ok && parsed.value.input.ssl).toBeUndefined();
  });

  it('reads a user and password as basic authentication', () => {
    const parsed = parseConnectionUrl('loki://ann:s%40cret@h:3100');
    expect(parsed).toMatchObject({
      ok: true,
      value: { input: { user: 'ann' }, password: 's@cret' },
    });
  });

  it('lets a token win over a user part, and drops the user then', () => {
    const parsed = parseConnectionUrl('loki://ann@h?token=t');
    expect(parsed.ok && parsed.value.input.user).toBeUndefined();
    expect(parsed.ok && parsed.value.password).toBe('t');
  });

  it('takes the org parameter for the tenant too', () => {
    const parsed = parseConnectionUrl('loki://h?org=acme');
    expect(parsed.ok && parsed.value.input.database).toBe('acme');
  });

  it('turns TLS on for lokis:// or tls=1', () => {
    for (const address of ['lokis://h', 'loki://h?tls=1', 'loki://h?tls=TRUE']) {
      const parsed = parseConnectionUrl(address);
      expect(parsed.ok && parsed.value.input.ssl, address).toEqual({ mode: 'verify-full' });
    }
  });

  it('asks for a host, and ignores a port out of range', () => {
    expect(parseConnectionUrl('loki:///x')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseConnectionUrl('loki://h:99999')).toEqual({ ok: false, problem: 'not-a-url' });
    const zero = parseConnectionUrl('loki://h:0');
    expect(zero.ok && zero.value.input.port).toBeUndefined();
  });

  it('suggests a name for the connection', () => {
    const parsed = parseConnectionUrl('loki://logs.example.com');
    expect(parsed.ok && parsed.value.input.name).toContain('logs.example.com');
  });
});
