// Statement templates completion offers where a statement begins. Bodies use the
// editor's snippet syntax: ${1:name} is a tab stop with a placeholder.

import type { DriverId } from '../../shared/connection';

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

const BY_DRIVER: Readonly<Record<DriverId, readonly SqlSnippet[]>> = {
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
};

export function snippetsOf(driver?: DriverId): readonly SqlSnippet[] {
  return driver === undefined ? COMMON : [...COMMON, ...BY_DRIVER[driver]];
}
