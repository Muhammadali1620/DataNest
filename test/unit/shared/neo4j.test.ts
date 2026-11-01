// What the rest of DataNest knows about a Neo4j connection (V13.21): the address a URL
// gives, the form's fields, and the places where Cypher is not SQL.

import { describe, expect, it } from 'vitest';
import { isSystemDatabase, isSystemSchema } from '../../../src/core/model/system-objects';
import type { ColumnInfo } from '../../../src/core/model/objects';
import { syntaxOf } from '../../../src/core/sql/tokenizer';
import { neo4jDialect } from '../../../src/drivers/neo4j/dialect';
import { planServerOf } from '../../../src/services/explain/explain';
import { cliCommand } from '../../../src/services/cli-command';
import { containsCondition } from '../../../src/services/data-search';
import { analyzeEditability } from '../../../src/services/result-editability';
import { DEFAULT_FORMAT_STYLE, formatEdits, languageOf } from '../../../src/services/sql-format';
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

describe('the neo4j driver in the shared tables', () => {
  it('is a SQL-shaped driver of its own, not a file and not a plugin', () => {
    expect(isSqlDriver('neo4j')).toBe(true);
    expect(driverFamily('neo4j')).toBe('sql');
    expect(isFileDriver('neo4j')).toBe(false);
    expect(SQL_DRIVER_IDS).toContain('neo4j');
    expect(DEFAULT_PORTS.neo4j).toBe(7474);
  });

  it('has databases to filter and one hidden: the server keeps its own in `system`', () => {
    expect(filterSupport('neo4j')).toEqual({ databases: true, schemas: false });
    expect(isSystemDatabase('neo4j', 'system')).toBe(true);
    expect(isSystemDatabase('neo4j', 'neo4j')).toBe(false);
    expect(isSystemSchema('neo4j', 'anything')).toBe(false);
  });

  it('offers the options of a network connection, without session statements', () => {
    expect(optionSupport('neo4j')).toEqual({
      connectTimeout: true,
      keepAlive: false,
      timeZone: false,
      charset: false,
      tls: true,
      queryTimeout: true,
      init: false,
    });
  });

  it('has no designer, no accounts, no manager sections and no table copy', () => {
    expect(canReorderColumns('neo4j')).toBe(false);
    expect(hasAccounts('neo4j')).toBe(false);
    expect(sectionsFor('neo4j')).toEqual([]);
    expect(() =>
      targetType({ kind: 'integer', bytes: 4, unsigned: false }, 'neo4j', false),
    ).toThrow(/Neo4j/u);
  });

  it('has a mark of its own, in every state', () => {
    const plain = dbMarkSvg('neo4j');
    expect(plain).toContain('<svg');
    expect(plain).not.toBe(dbMarkSvg('libsql'));
    expect(dbMarkFile('neo4j')).toBe('neo4j.svg');
    expect(dbMarkFile('neo4j', 'off')).toBe('neo4j-off.svg');
    expect(dbMarkSvg('neo4j', 16, 'error')).not.toBe(dbMarkSvg('neo4j', 16, 'on'));
  });

  it('has no command line client we can start', () => {
    expect(
      cliCommand(
        { id: 'a', name: 'a', driver: 'neo4j', host: 'h' },
        'cypher-shell',
        undefined,
        undefined,
      ),
    ).toBeUndefined();
  });

  it('cannot show a plan', async () => {
    await expect(planServerOf({} as never, 'neo4j')).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('the places where Cypher is not SQL', () => {
  it('is not formatted: the SQL formatter would garble a pattern', () => {
    expect(languageOf('neo4j')).toBe('sql');
    const formatter = {
      format: () => {
        throw new Error('the formatter must not be asked');
      },
    };
    expect(
      formatEdits('MATCH (a)-[r]->(b) RETURN a', 'neo4j', DEFAULT_FORMAT_STYLE, formatter),
    ).toEqual({ edits: [], failed: 0 });
  });

  it('searches text with a regular expression', () => {
    const condition = containsCondition('name', 'a.b(c)', neo4jDialect, 'neo4j');
    expect(condition).toBe("toString(`name`) =~ '(?is).*a\\\\.b\\\\(c\\\\).*'");
  });

  it('keeps every result read-only, and says why', async () => {
    const metadata = new FakeMetadata();
    metadata.tables = [{ name: 'Person', kind: 'table' }];
    metadata.columns = [
      { name: 'id', dataType: 'string', nullable: false, primaryKey: true } satisfies ColumnInfo,
    ];
    const result = await analyzeEditability(
      {
        metadata,
        syntax: syntaxOf('neo4j'),
        schemas: false,
        logger: new RecordingLogger(),
        driver: 'neo4j',
      },
      'SELECT * FROM `Person`',
      ['id'],
    );
    expect(result).toMatchObject({ editable: false, reason: 'graph' });
    expect(READ_ONLY_REASONS).toContain('graph');
  });
});

describe('Neo4j URLs (V13.21)', () => {
  const ok = (text: string) => {
    const result = parseConnectionUrl(text);
    if (!result.ok) {
      throw new Error(`expected a connection, got ${result.problem}`);
    }
    return result.value;
  };

  it('knows the neo4j scheme, with or without +s', () => {
    expect(urlDriver('neo4j://localhost')).toBe('neo4j');
    expect(urlDriver('neo4j+s://x.databases.neo4j.io')).toBe('neo4j');
    expect(urlDriver('NEO4J+ssc://h')).toBe('neo4j');
  });

  it('reads user, password and database, and drops the Bolt port', () => {
    expect(ok('neo4j://neo4j:s3cret@db.example.com:7687/sales')).toEqual({
      input: {
        name: 'sales',
        driver: 'neo4j',
        host: 'db.example.com',
        user: 'neo4j',
        database: 'sales',
      },
      password: 's3cret',
    });
  });

  it('keeps another port, and a password with escapes', () => {
    const value = ok('neo4j://u:p%40ss@h:7474');
    expect(value.input.port).toBe(7474);
    expect(value.password).toBe('p@ss');
  });

  it('asks for TLS with +s and +ssc', () => {
    expect(ok('neo4j+s://x.databases.neo4j.io').input.ssl).toEqual({ mode: 'verify-full' });
    expect(ok('neo4j+ssc://h').input.ssl).toEqual({ mode: 'verify-full' });
    expect(ok('neo4j://h').input.ssl).toBeUndefined();
  });

  it('works with nothing but a host', () => {
    const value = ok('neo4j://h');
    expect(value.password).toBeUndefined();
    expect(value.input.user).toBeUndefined();
    expect(value.input.database).toBeUndefined();
  });

  it('ignores a port that is no port', () => {
    expect(ok('neo4j://h:0').input.port).toBeUndefined();
  });

  it('needs a host', () => {
    expect(parseConnectionUrl('neo4j://')).toEqual({ ok: false, problem: 'no-host' });
  });
});
