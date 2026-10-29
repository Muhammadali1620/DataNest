import { describe, expect, it } from 'vitest';
import {
  isSystemDatabase,
  isSystemSchema,
  withoutSystemDatabases,
  withoutSystemSchemas,
} from '../../../../src/core/model/system-objects';

describe('isSystemDatabase', () => {
  it('knows the MySQL built-ins', () => {
    for (const name of ['information_schema', 'performance_schema', 'mysql', 'sys']) {
      expect(isSystemDatabase('mysql', name), name).toBe(true);
    }
  });

  it('knows the PostgreSQL templates', () => {
    expect(isSystemDatabase('postgres', 'template0')).toBe(true);
    expect(isSystemDatabase('postgres', 'template1')).toBe(true);
  });

  it('keeps the PostgreSQL "postgres" database visible, since people use it', () => {
    expect(isSystemDatabase('postgres', 'postgres')).toBe(false);
  });

  it('ignores case', () => {
    expect(isSystemDatabase('mysql', 'INFORMATION_SCHEMA')).toBe(true);
    expect(isSystemDatabase('mysql', 'MySQL')).toBe(true);
  });

  it('leaves user databases alone', () => {
    for (const name of ['app', 'datanest_test', 'my_information_schema', 'sysadmin']) {
      expect(isSystemDatabase('mysql', name), name).toBe(false);
    }
  });

  it('does not apply the list of one server to another', () => {
    // `mysql` is a built-in database only on MySQL.
    expect(isSystemDatabase('postgres', 'mysql')).toBe(false);
    expect(isSystemDatabase('mysql', 'template0')).toBe(false);
  });

  it('has nothing to hide for a single-file database', () => {
    expect(isSystemDatabase('sqlite', 'main')).toBe(false);
  });
});

describe('isSystemSchema', () => {
  it('knows the PostgreSQL catalogs', () => {
    expect(isSystemSchema('postgres', 'pg_catalog')).toBe(true);
    expect(isSystemSchema('postgres', 'information_schema')).toBe(true);
  });

  it('knows the generated schemas by prefix', () => {
    expect(isSystemSchema('postgres', 'pg_toast')).toBe(true);
    expect(isSystemSchema('postgres', 'pg_toast_temp_7')).toBe(true);
    expect(isSystemSchema('postgres', 'pg_temp_3')).toBe(true);
  });

  it('leaves user schemas alone, including look-alikes', () => {
    for (const name of ['public', 'audit', 'pgcrypto', 'my_pg_catalog']) {
      expect(isSystemSchema('postgres', name), name).toBe(false);
    }
  });

  it('ignores case', () => {
    expect(isSystemSchema('postgres', 'PG_CATALOG')).toBe(true);
    expect(isSystemSchema('postgres', 'PG_Temp_1')).toBe(true);
  });

  it('has nothing to hide where there are no schemas', () => {
    expect(isSystemSchema('mysql', 'information_schema')).toBe(false);
    expect(isSystemSchema('sqlite', 'main')).toBe(false);
  });
});

describe('withoutSystemDatabases', () => {
  it('keeps the server order and drops only the built-ins', () => {
    expect(
      withoutSystemDatabases('mysql', ['app', 'information_schema', 'shop', 'mysql', 'sys']),
    ).toEqual(['app', 'shop']);
  });

  it('returns an empty list when everything is a built-in', () => {
    expect(withoutSystemDatabases('mysql', ['mysql', 'sys'])).toEqual([]);
  });

  it('passes an empty list through', () => {
    expect(withoutSystemDatabases('postgres', [])).toEqual([]);
  });
});

describe('withoutSystemSchemas', () => {
  it('keeps user schemas in order', () => {
    expect(
      withoutSystemSchemas('postgres', [
        'public',
        'pg_catalog',
        'audit',
        'information_schema',
        'pg_toast',
      ]),
    ).toEqual(['public', 'audit']);
  });

  it('leaves MySQL schema lists untouched', () => {
    expect(withoutSystemSchemas('mysql', ['whatever'])).toEqual(['whatever']);
  });
});

describe('SQL Server system objects (V6.2)', () => {
  it('hides the four system databases, case-insensitively', () => {
    for (const name of ['master', 'model', 'msdb', 'tempdb', 'TempDB']) {
      expect(isSystemDatabase('mssql', name), name).toBe(true);
    }
    expect(withoutSystemDatabases('mssql', ['master', 'shop', 'tempdb'])).toEqual(['shop']);
  });

  it('hides sys, INFORMATION_SCHEMA and guest, keeps dbo and user schemas', () => {
    expect(
      withoutSystemSchemas('mssql', ['dbo', 'sys', 'INFORMATION_SCHEMA', 'guest', 'app']),
    ).toEqual(['dbo', 'app']);
    expect(isSystemSchema('mssql', 'dbo')).toBe(false);
  });
});

describe('ClickHouse system objects (V6.3)', () => {
  it('hides the system and information schema databases, whatever their case', () => {
    for (const name of ['system', 'INFORMATION_SCHEMA', 'information_schema', 'System']) {
      expect(isSystemDatabase('clickhouse', name), name).toBe(true);
    }
    expect(withoutSystemDatabases('clickhouse', ['default', 'system', 'shop'])).toEqual([
      'default',
      'shop',
    ]);
  });

  it('has no schemas of its own to hide', () => {
    expect(isSystemSchema('clickhouse', 'system')).toBe(false);
    expect(withoutSystemSchemas('clickhouse', ['a'])).toEqual(['a']);
  });
});

describe('Oracle system objects (V6.4)', () => {
  it('hides SYS, SYSTEM and PDBADMIN, whatever their case', () => {
    for (const name of ['SYS', 'SYSTEM', 'PDBADMIN', 'sys']) {
      expect(isSystemSchema('oracle', name), name).toBe(true);
    }
    expect(withoutSystemSchemas('oracle', ['APP', 'SYS', 'HR', 'SYSTEM', 'PDBADMIN'])).toEqual([
      'APP',
      'HR',
    ]);
  });

  it('keeps schemas that only start like a system one', () => {
    expect(isSystemSchema('oracle', 'SYSADM')).toBe(false);
    expect(isSystemSchema('oracle', 'SYSTEM_APP')).toBe(false);
  });

  it('has no system databases: the service is the only one', () => {
    expect(isSystemDatabase('oracle', 'ORCLPDB1')).toBe(false);
    expect(isSystemDatabase('oracle', 'SYS')).toBe(false);
    expect(withoutSystemDatabases('oracle', ['FREEPDB1'])).toEqual(['FREEPDB1']);
  });
});

describe('servers that speak MySQL and PostgreSQL (V6.5)', () => {
  it("hides TiDB's metrics and the CockroachDB and YugabyteDB databases of their own", () => {
    expect(isSystemDatabase('mysql', 'METRICS_SCHEMA')).toBe(true);
    expect(isSystemDatabase('postgres', 'system')).toBe(true);
    expect(isSystemDatabase('postgres', 'system_platform')).toBe(true);
    expect(isSystemDatabase('postgres', 'defaultdb')).toBe(false);
    expect(isSystemDatabase('postgres', 'yugabyte')).toBe(false);
  });

  it("hides CockroachDB's own schemas", () => {
    expect(isSystemSchema('postgres', 'crdb_internal')).toBe(true);
    expect(isSystemSchema('postgres', 'pg_extension')).toBe(true);
    expect(isSystemSchema('postgres', 'public')).toBe(false);
  });
});
