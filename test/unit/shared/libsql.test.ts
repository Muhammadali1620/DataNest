// What the rest of DataNest knows about a libSQL connection (V13.17): the address a URL
// gives, the form's fields, the rules it shares with SQLite and the ones it does not.

import { describe, expect, it } from 'vitest';
import { findVariables } from '../../../src/core/sql/variables';
import { isSystemDatabase, isSystemSchema } from '../../../src/core/model/system-objects';
import { KEYWORDS } from '../../../src/core/sql/keywords';
import { snippetsOf } from '../../../src/core/sql/snippets';
import { functionsOf } from '../../../src/core/sql/functions';
import { languageOf } from '../../../src/services/sql-format';
import { targetType } from '../../../src/services/transfer/type-map';
import { hasAccounts } from '../../../src/services/users/account-list';
import {
  DEFAULT_PORTS,
  driverFamily,
  filterSupport,
  isFileDriver,
  isSqlDriver,
  optionSupport,
  SQL_DRIVER_IDS,
} from '../../../src/shared/connection';
import { parseConnectionUrl, urlDriver } from '../../../src/shared/connection-url';
import { dbMarkFile, dbMarkSvg } from '../../../src/shared/db-marks';
import { canReorderColumns } from '../../../src/shared/table-design';
import { sectionsFor } from '../../../src/vscode/panels/manager-model';

describe('the libsql driver in the shared tables', () => {
  it('is a SQL driver of its own, not a file and not a plugin', () => {
    expect(isSqlDriver('libsql')).toBe(true);
    expect(driverFamily('libsql')).toBe('sql');
    expect(isFileDriver('libsql')).toBe(false);
    expect(SQL_DRIVER_IDS).toContain('libsql');
    expect(DEFAULT_PORTS.libsql).toBe(8080);
  });

  it('has no databases or schemas to filter', () => {
    expect(filterSupport('libsql')).toEqual({ databases: false, schemas: false });
    expect(isSystemDatabase('libsql', 'main')).toBe(false);
    expect(isSystemSchema('libsql', 'main')).toBe(false);
  });

  it('offers the options of a network connection, without a socket to keep alive', () => {
    expect(optionSupport('libsql')).toEqual({
      connectTimeout: true,
      keepAlive: false,
      timeZone: false,
      charset: false,
      tls: true,
      queryTimeout: true,
      init: true,
    });
  });

  it('speaks SQLite: keywords, functions, snippets, formatter and column moves', () => {
    expect(KEYWORDS.libsql).toBe(KEYWORDS.sqlite);
    expect(functionsOf('libsql')).toEqual(functionsOf('sqlite'));
    expect(snippetsOf('libsql')).toEqual(snippetsOf('sqlite'));
    expect(languageOf('libsql')).toBe('sqlite');
    expect(canReorderColumns('libsql')).toBe(canReorderColumns('sqlite'));
    expect(canReorderColumns('libsql')).toBe(true);
  });

  it('asks for the placeholders of SQLite, `?` and `?3`', () => {
    const sql = 'SELECT * FROM t WHERE a = ? AND b = ?3';
    expect(findVariables(sql, 'libsql')).toEqual(findVariables(sql, 'sqlite'));
    expect(findVariables(sql, 'libsql').map((variable) => variable.name)).toEqual(['?1', '?3']);
  });

  it('can be the target of a table copy, with the types of SQLite', () => {
    expect(targetType({ kind: 'integer', bytes: 4, unsigned: false }, 'libsql', false)).toEqual(
      targetType({ kind: 'integer', bytes: 4, unsigned: false }, 'sqlite', false),
    );
  });

  it('has no accounts to list and no process list', () => {
    expect(hasAccounts('libsql')).toBe(false);
    expect(sectionsFor('libsql')).toEqual(sectionsFor('sqlite'));
  });

  it('has a mark of its own, in every state', () => {
    const plain = dbMarkSvg('libsql');
    expect(plain).toContain('<svg');
    expect(plain).not.toBe(dbMarkSvg('sqlite'));
    expect(dbMarkFile('libsql')).toBe('libsql.svg');
    expect(dbMarkFile('libsql', 'on')).toBe('libsql-on.svg');
    expect(dbMarkSvg('libsql', 16, 'error')).not.toBe(dbMarkSvg('libsql', 16, 'on'));
  });
});

describe('libSQL URLs (V13.17)', () => {
  const ok = (text: string) => {
    const result = parseConnectionUrl(text);
    if (!result.ok) {
      throw new Error(`expected a connection, got ${result.problem}`);
    }
    return result.value;
  };

  it('knows the libsql and turso schemes', () => {
    expect(urlDriver('libsql://db-org.turso.io')).toBe('libsql');
    expect(urlDriver('LIBSQL://h')).toBe('libsql');
    expect(urlDriver('turso://h')).toBe('libsql');
  });

  it('turns TLS on and keeps the token as the password', () => {
    expect(ok('libsql://db-org.turso.io?authToken=abc.def')).toEqual({
      input: {
        name: 'db-org.turso.io',
        driver: 'libsql',
        host: 'db-org.turso.io',
        ssl: { mode: 'verify-full' },
      },
      password: 'abc.def',
    });
  });

  it('reads a port, and `token` as another name for the token', () => {
    const value = ok('libsql://db.example.com:8443?token=t');
    expect(value.input.port).toBe(8443);
    expect(value.password).toBe('t');
  });

  it('asks for plain HTTP with tls=0', () => {
    const value = ok('libsql://127.0.0.1:8080?tls=0');
    expect(value.input.ssl).toBeUndefined();
    expect(value.input.host).toBe('127.0.0.1');
    expect(ok('libsql://h?tls=false').input.ssl).toBeUndefined();
  });

  it('works without a token', () => {
    expect(ok('libsql://h').password).toBeUndefined();
  });

  it('ignores a port that is no port', () => {
    expect(ok('libsql://h:0').input.port).toBeUndefined();
  });

  it('needs a host', () => {
    expect(parseConnectionUrl('libsql://')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseConnectionUrl('libsql:///x')).toEqual({ ok: false, problem: 'no-host' });
  });
});
