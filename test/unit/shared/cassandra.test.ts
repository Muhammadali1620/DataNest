// What the rest of DataNest knows about a Cassandra connection (V13.22): the address a URL
// gives, the shared tables, and the places where CQL is not SQL.

import { describe, expect, it } from 'vitest';
import { isSystemDatabase, isSystemSchema } from '../../../src/core/model/system-objects';
import type { ColumnInfo } from '../../../src/core/model/objects';
import { identifierProblem } from '../../../src/core/sql/identifiers';
import { KEYWORDS } from '../../../src/core/sql/keywords';
import { functionsOf } from '../../../src/core/sql/functions';
import { isReadOnlyStatement } from '../../../src/core/sql/read-only';
import { snippetsOf } from '../../../src/core/sql/snippets';
import { splitStatements } from '../../../src/core/sql/split';
import { syntaxOf, tokenize } from '../../../src/core/sql/tokenizer';
import { cassandraDialect } from '../../../src/drivers/cassandra/dialect';
import { buildWhere } from '../../../src/services/table-filter-sql';
import { planServerOf } from '../../../src/services/explain/explain';
import { cliCommand } from '../../../src/services/cli-command';
import { containsCondition } from '../../../src/services/data-search';
import { analyzeEditability } from '../../../src/services/result-editability';
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
import { READ_ONLY_REASONS } from '../../../src/shared/read-only-reason';
import { canReorderColumns } from '../../../src/shared/table-design';
import { sectionsFor } from '../../../src/vscode/panels/manager-model';
import { FakeMetadata } from '../../helpers/fake-driver';
import { RecordingLogger } from '../../helpers/fakes';

describe('the cassandra driver in the shared tables', () => {
  it('is a SQL-shaped driver of its own, not a file and not a plugin', () => {
    expect(isSqlDriver('cassandra')).toBe(true);
    expect(driverFamily('cassandra')).toBe('sql');
    expect(isFileDriver('cassandra')).toBe(false);
    expect(SQL_DRIVER_IDS).toContain('cassandra');
    expect(DEFAULT_PORTS.cassandra).toBe(9042);
  });

  it('has keyspaces to filter, and the ones the server keeps are hidden', () => {
    expect(filterSupport('cassandra')).toEqual({ databases: true, schemas: false });
    for (const name of [
      'system',
      'system_schema',
      'system_auth',
      'system_distributed',
      'system_traces',
      'system_views',
      'system_virtual_schema',
    ]) {
      expect(isSystemDatabase('cassandra', name), name).toBe(true);
    }
    expect(isSystemDatabase('cassandra', 'shop')).toBe(false);
    expect(isSystemSchema('cassandra', 'anything')).toBe(false);
  });

  it('offers the options of a network connection, with init statements for CONSISTENCY', () => {
    expect(optionSupport('cassandra')).toEqual({
      connectTimeout: true,
      keepAlive: false,
      timeZone: false,
      charset: false,
      tls: true,
      queryTimeout: true,
      init: true,
    });
  });

  it('has no designer, no accounts, no manager sections and no table copy', () => {
    expect(canReorderColumns('cassandra')).toBe(false);
    expect(hasAccounts('cassandra')).toBe(false);
    expect(sectionsFor('cassandra')).toEqual([]);
    expect(() =>
      targetType({ kind: 'integer', bytes: 4, unsigned: false }, 'cassandra', false),
    ).toThrow(/Cassandra/u);
  });

  it('limits names to 48 characters', () => {
    expect(identifierProblem('a'.repeat(48), 'cassandra')).toBeUndefined();
    expect(identifierProblem('a'.repeat(49), 'cassandra')).toBe('too-long');
  });

  it('has a mark of its own, in every state', () => {
    const plain = dbMarkSvg('cassandra');
    expect(plain).toContain('<svg');
    expect(plain).not.toBe(dbMarkSvg('neo4j'));
    expect(dbMarkFile('cassandra')).toBe('cassandra.svg');
    expect(dbMarkFile('cassandra', 'off')).toBe('cassandra-off.svg');
    expect(dbMarkSvg('cassandra', 16, 'error')).not.toBe(dbMarkSvg('cassandra', 16, 'on'));
  });

  it('has no command line client we can start', () => {
    expect(
      cliCommand(
        { id: 'a', name: 'a', driver: 'cassandra', host: 'h' },
        'cqlsh',
        undefined,
        undefined,
      ),
    ).toBeUndefined();
  });

  it('cannot show a plan', async () => {
    await expect(planServerOf({} as never, 'cassandra')).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('the places where CQL is not SQL', () => {
  it('is formatted as standard SQL', () => {
    expect(languageOf('cassandra')).toBe('sql');
  });

  it('cannot search all columns: there is no case-insensitive match', () => {
    expect(() => containsCondition('name', 'x', cassandraDialect, 'cassandra')).toThrow(
      /Cassandra/u,
    );
  });

  it('keeps every result read-only, and says why', async () => {
    const metadata = new FakeMetadata();
    metadata.tables = [{ name: 'users', kind: 'table' }];
    metadata.columns = [
      { name: 'id', dataType: 'uuid', nullable: false, primaryKey: true } satisfies ColumnInfo,
    ];
    const result = await analyzeEditability(
      {
        metadata,
        syntax: syntaxOf('cassandra'),
        schemas: false,
        logger: new RecordingLogger(),
        driver: 'cassandra',
      },
      'SELECT * FROM "shop"."users"',
      ['id'],
    );
    expect(result).toMatchObject({ editable: false, reason: 'wide-column' });
    expect(READ_ONLY_REASONS).toContain('wide-column');
  });
});

describe('table filters in CQL', () => {
  const types = new Map([
    ['seq', 'int'],
    ['room', 'text'],
    ['id', 'uuid'],
  ]);

  it('compares each column with a literal of its own type', () => {
    expect(
      buildWhere(
        cassandraDialect,
        'cassandra',
        {
          conditions: [
            { column: 'room', operator: 'eq', value: '7' },
            { column: 'seq', operator: 'ge', value: '7' },
            { column: 'id', operator: 'eq', value: '123e4567-e89b-12d3-a456-426614174000' },
          ],
        },
        types,
      ),
    ).toBe(`"room" = '7' AND "seq" >= 7 AND "id" = 123e4567-e89b-12d3-a456-426614174000`);
  });

  it('falls back to text when the types are unknown', () => {
    expect(
      buildWhere(cassandraDialect, 'cassandra', {
        conditions: [{ column: 'seq', operator: 'eq', value: '7' }],
      }),
    ).toBe(`"seq" = '7'`);
  });

  it('puts a hand-written condition in without parentheses, which CQL does not take', () => {
    expect(
      buildWhere(cassandraDialect, 'cassandra', {
        conditions: [{ column: 'room', operator: 'eq', value: 'main' }],
        where: 'seq > 20 -- newest',
      }),
    ).toBe(`"room" = 'main' AND seq > 20 -- newest\n`);
  });

  it('still refuses a second statement in a hand-written condition', () => {
    expect(() =>
      buildWhere(cassandraDialect, 'cassandra', { conditions: [], where: 'a = 1; DROP TABLE t' }),
    ).toThrow();
  });
});

describe('CQL as the editor reads it', () => {
  const kinds = (sql: string): string[] =>
    tokenize(sql, syntaxOf('cassandra'))
      .filter((token) => token.kind !== 'whitespace')
      .map((token) => token.kind);

  it('reads -- and // as comments, doubled quotes inside strings and "…" as names', () => {
    expect(kinds("SELECT 'it''s' -- x")).toEqual(['word', 'string', 'comment']);
    expect(kinds('SELECT "My Col" // y')).toEqual(['word', 'quoted-identifier', 'comment']);
    expect(kinds('/* c */ SELECT')).toEqual(['comment', 'word']);
  });

  it('reads $$ … $$ as one string, so a function body keeps its semicolons', () => {
    const sql =
      'CREATE FUNCTION f(a int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS $$ return a; $$; SELECT 1;';
    expect(splitStatements(sql, 'cassandra').map((statement) => statement.text)).toEqual([
      'CREATE FUNCTION f(a int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS $$ return a; $$',
      'SELECT 1',
    ]);
  });

  it('keeps a backslash an ordinary character in a string', () => {
    expect(kinds("SELECT 'a\\' FROM t")).toEqual(['word', 'string', 'word', 'word']);
  });

  it('tells reads from changes', () => {
    const syntax = syntaxOf('cassandra');
    for (const sql of [
      'SELECT * FROM ks.t WHERE id = 1',
      'SELECT JSON * FROM ks.t',
      'USE ks',
      'DESCRIBE KEYSPACES',
      'CONSISTENCY QUORUM',
      'CONSISTENCY',
      'LIST ROLES',
      '-- only a comment',
    ]) {
      expect(isReadOnlyStatement(sql, syntax), sql).toBe(true);
    }
    for (const sql of [
      'INSERT INTO ks.t (id) VALUES (1)',
      'UPDATE ks.t SET v = 1 WHERE id = 1',
      'DELETE FROM ks.t WHERE id = 1',
      'TRUNCATE ks.t',
      'DROP TABLE ks.t',
      'ALTER TABLE ks.t ADD c int',
      "CREATE KEYSPACE k WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}",
      'BEGIN BATCH INSERT INTO ks.t (id) VALUES (1) APPLY BATCH',
      'GRANT SELECT ON ALL KEYSPACES TO bob',
    ]) {
      expect(isReadOnlyStatement(sql, syntax), sql).toBe(false);
    }
  });

  it('has its own keywords, functions and snippets, none of the SQL ones that CQL lacks', () => {
    expect(KEYWORDS.cassandra).toContain('ALLOW FILTERING');
    expect(KEYWORDS.cassandra).toContain('CLUSTERING ORDER BY');
    expect(KEYWORDS.cassandra).not.toContain('JOIN');
    expect(KEYWORDS.cassandra).not.toContain('OFFSET');
    const functions = functionsOf('cassandra').map((fn) => fn.name);
    expect(functions).toContain('TOKEN');
    expect(functions).toContain('WRITETIME');
    expect(functions).not.toContain('COALESCE');
    const snippets = snippetsOf('cassandra');
    expect(snippets.map((snippet) => snippet.prefix)).toContain('table');
    expect(snippets.every((snippet) => !snippet.body.includes('JOIN'))).toBe(true);
    const keyspace = snippets.find((snippet) => snippet.prefix === 'keyspace');
    expect(keyspace?.body).toContain("'class': 'SimpleStrategy'");
  });
});

describe('Cassandra URLs (V13.22)', () => {
  const ok = (text: string) => {
    const result = parseConnectionUrl(text);
    if (!result.ok) {
      throw new Error(`expected a connection, got ${result.problem}`);
    }
    return result.value;
  };

  it('knows the cassandra and cql schemes', () => {
    expect(urlDriver('cassandra://localhost')).toBe('cassandra');
    expect(urlDriver('CQL://h')).toBe('cassandra');
  });

  it('reads user, password, port and keyspace', () => {
    expect(ok('cassandra://app:s3cret@db.example.com:9142/shop')).toEqual({
      input: {
        name: 'shop',
        driver: 'cassandra',
        host: 'db.example.com',
        port: 9142,
        user: 'app',
        database: 'shop',
      },
      password: 's3cret',
    });
  });

  it('asks for TLS with ssl=true', () => {
    expect(ok('cassandra://h?ssl=true').input.ssl).toBeDefined();
    expect(ok('cassandra://h').input.ssl).toBeUndefined();
  });

  it('needs a host', () => {
    expect(parseConnectionUrl('cassandra://')).toEqual({ ok: false, problem: 'no-host' });
  });
});
