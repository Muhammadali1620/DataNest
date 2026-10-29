// What a MySQL dump script looks like (V5.2): the session settings mysqldump also
// writes, so the script loads in any order and puts the session back at the end.

import type { ObjectRef, RelationKind, TableRef } from '../../core/model/objects';
import type { DumpDialect } from '../driver';
import { quoteTable } from './quote';

/** Written and read in UTC, so TIMESTAMP values survive a server in another zone. */
const DUMP_TIME_ZONE = "'+00:00'";

const QUOTED = "`(?:[^`]|``)*`|'(?:[^']|'')*'";
/** `DEFINER=user@host` right after CREATE (and ALGORITHM=… of a view). */
const DEFINER = new RegExp(
  `^(\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:ALGORITHM\\s*=\\s*\\w+\\s+)?)DEFINER\\s*=\\s*(?:${QUOTED}|[\\w.$-]+)(?:\\s*@\\s*(?:${QUOTED}|[\\w.%$-]+))?\\s+`,
  'iu',
);

/**
 * Drops the DEFINER clause: on another server the original user rarely exists, and
 * naming a user other than oneself needs administrator rights. Objects then belong
 * to whoever loads the script, which is what a restore means.
 */
export function withoutDefiner(sql: string): string {
  return sql.replace(DEFINER, '$1');
}

function names(tables: readonly TableRef[]): string {
  return tables.map((table) => quoteTable(table)).join(', ');
}

export const mysqlDump: DumpDialect = {
  prepare: [
    `SET time_zone = ${DUMP_TIME_ZONE}`,
    // A consistent snapshot means one only under REPEATABLE READ.
    'SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ',
  ],
  // The dump session only reads; TiDB takes no READ ONLY next to CONSISTENT SNAPSHOT.
  beginSnapshot: ['START TRANSACTION WITH CONSISTENT SNAPSHOT'],
  endSnapshot: ['ROLLBACK'],
  header: [
    'SET NAMES utf8mb4',
    `SET @OLD_TIME_ZONE = @@TIME_ZONE, TIME_ZONE = ${DUMP_TIME_ZONE}`,
    'SET @OLD_FOREIGN_KEY_CHECKS = @@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS = 0',
    'SET @OLD_UNIQUE_CHECKS = @@UNIQUE_CHECKS, UNIQUE_CHECKS = 0',
    // Without it an id of 0 in an AUTO_INCREMENT column becomes the next number.
    "SET @OLD_SQL_MODE = @@SQL_MODE, SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'",
  ],
  footer: [
    'SET SQL_MODE = @OLD_SQL_MODE',
    'SET UNIQUE_CHECKS = @OLD_UNIQUE_CHECKS',
    'SET FOREIGN_KEY_CHECKS = @OLD_FOREIGN_KEY_CHECKS',
    'SET TIME_ZONE = @OLD_TIME_ZONE',
  ],
  keysAfterData: false,
  routinesFirst: false,
  portable: withoutDefiner,
  insert: (quotedTable, quotedColumns, rows) =>
    `INSERT INTO ${quotedTable} (${quotedColumns.join(', ')}) VALUES\n${rows.join(',\n')}`,
  dropRelations: (tables: readonly TableRef[], kind: RelationKind) =>
    tables.length === 0
      ? []
      : [`DROP ${kind === 'table' ? 'TABLE' : 'VIEW'} IF EXISTS ${names(tables)}`],
  dropObject: (object: ObjectRef) => {
    const word =
      object.kind === 'table'
        ? 'TABLE'
        : object.kind === 'view'
          ? 'VIEW'
          : object.kind.toUpperCase();
    return `DROP ${word} IF EXISTS ${quoteTable(object)}`;
  },
};
