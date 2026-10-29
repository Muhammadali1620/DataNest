// Statement templates completion offers where a statement begins. Bodies use the
// editor's snippet syntax: ${1:name} is a tab stop with a placeholder.

import { type DriverId, isSqlDriver, type SqlDriverId } from '../../shared/connection';

export interface SqlSnippet {
  /** What the user types to find it. */
  readonly prefix: string;
  /** What it inserts, in a few words. */
  readonly title: string;
  readonly body: string;
}

const COMMON: readonly SqlSnippet[] = [
  {
    prefix: 'sel',
    title: 'SELECT … FROM … WHERE',
    body: 'SELECT ${1:*}\nFROM ${2:table}\nWHERE ${3:condition};',
  },
  {
    prefix: 'selc',
    title: 'SELECT COUNT(*) … GROUP BY',
    body: 'SELECT ${1:column}, COUNT(*)\nFROM ${2:table}\nGROUP BY ${1:column}\nORDER BY COUNT(*) DESC;',
  },
  {
    prefix: 'join',
    title: 'SELECT … JOIN … ON',
    body: 'SELECT ${1:*}\nFROM ${2:table} ${3:a}\nJOIN ${4:other} ${5:b} ON ${5:b}.${6:id} = ${3:a}.${7:other_id};',
  },
  {
    prefix: 'ins',
    title: 'INSERT INTO … VALUES',
    body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values});',
  },
  {
    prefix: 'upd',
    title: 'UPDATE … SET … WHERE',
    body: 'UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};',
  },
  {
    prefix: 'del',
    title: 'DELETE FROM … WHERE',
    body: 'DELETE FROM ${1:table}\nWHERE ${2:condition};',
  },
  {
    prefix: 'cte',
    title: 'WITH … AS (…) SELECT',
    body: 'WITH ${1:name} AS (\n  SELECT ${2:*}\n  FROM ${3:table}\n)\nSELECT *\nFROM ${1:name};',
  },
  {
    prefix: 'case',
    title: 'CASE WHEN … THEN … ELSE … END',
    body: 'CASE\n  WHEN ${1:condition} THEN ${2:value}\n  ELSE ${3:other}\nEND',
  },
];

const BY_DRIVER: Readonly<Record<SqlDriverId, readonly SqlSnippet[]>> = {
  mysql: [
    {
      prefix: 'upsert',
      title: 'INSERT … ON DUPLICATE KEY UPDATE',
      body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})\nON DUPLICATE KEY UPDATE ${4:column} = VALUES(${4:column});',
    },
  ],
  postgres: [
    {
      prefix: 'upsert',
      title: 'INSERT … ON CONFLICT DO UPDATE',
      body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})\nON CONFLICT (${4:key}) DO UPDATE SET ${5:column} = EXCLUDED.${5:column};',
    },
  ],
  sqlite: [
    {
      prefix: 'upsert',
      title: 'INSERT … ON CONFLICT DO UPDATE',
      body: 'INSERT INTO ${1:table} (${2:columns})\nVALUES (${3:values})\nON CONFLICT (${4:key}) DO UPDATE SET ${5:column} = excluded.${5:column};',
    },
  ],
  mssql: [
    {
      prefix: 'upsert',
      title: 'MERGE … WHEN MATCHED … WHEN NOT MATCHED',
      body: 'MERGE INTO ${1:table} AS t\nUSING (VALUES (${2:values})) AS s (${3:columns})\nON t.${4:key} = s.${4:key}\nWHEN MATCHED THEN UPDATE SET ${5:column} = s.${5:column}\nWHEN NOT MATCHED THEN INSERT (${3:columns}) VALUES (${2:values});',
    },
    {
      prefix: 'top',
      title: 'SELECT TOP … FROM … ORDER BY',
      body: 'SELECT TOP (${1:100}) ${2:*}\nFROM ${3:table}\nORDER BY ${4:column};',
    },
    {
      prefix: 'proc',
      title: 'CREATE OR ALTER PROCEDURE … AS BEGIN … END',
      body: 'CREATE OR ALTER PROCEDURE ${1:name}\n  @${2:id} INT\nAS\nBEGIN\n  SET NOCOUNT ON;\n  ${3:SELECT 1;}\nEND\nGO',
    },
  ],
  clickhouse: [
    {
      prefix: 'table',
      title: 'CREATE TABLE … ENGINE = MergeTree ORDER BY',
      body: 'CREATE TABLE ${1:name} (\n  ${2:id} UInt64,\n  ${3:created_at} DateTime DEFAULT now()\n)\nENGINE = MergeTree\nORDER BY (${2:id});',
    },
    {
      prefix: 'final',
      title: 'SELECT … FROM … FINAL',
      body: 'SELECT ${1:*}\nFROM ${2:table} FINAL\nWHERE ${3:condition};',
    },
  ],
  oracle: [
    {
      prefix: 'top',
      title: 'SELECT … FETCH FIRST n ROWS ONLY',
      body: 'SELECT ${1:*}\nFROM ${2:table}\nORDER BY ${3:column}\nFETCH FIRST ${4:100} ROWS ONLY;',
    },
    {
      prefix: 'proc',
      title: 'CREATE OR REPLACE PROCEDURE … IS BEGIN … END',
      body: 'CREATE OR REPLACE PROCEDURE ${1:name}(${2:p_id} IN NUMBER) IS\nBEGIN\n  ${3:NULL;}\nEND;\n/',
    },
    {
      prefix: 'block',
      title: 'BEGIN … EXCEPTION … END',
      body: 'BEGIN\n  ${1:NULL;}\nEXCEPTION\n  WHEN OTHERS THEN\n    ${2:RAISE;}\nEND;\n/',
    },
  ],
};

export function snippetsOf(driver?: DriverId): readonly SqlSnippet[] {
  return driver === undefined || !isSqlDriver(driver) ? COMMON : [...COMMON, ...BY_DRIVER[driver]];
}
