// Which server speaks PostgreSQL's protocol (V6.5): PostgreSQL itself, or CockroachDB
// and YugabyteDB, which keep most of its catalogs but not all. Read once per session from
// version(); catalog queries choose their variant by it.

import { unquoteIdentifier } from '../../core/sql/identifiers';
import { syntaxOf, textOf, tokenize } from '../../core/sql/tokenizer';

/** The servers DataNest knows apart; anything else is taken for PostgreSQL. */
export type PgFlavor = 'postgres' | 'cockroach' | 'yugabyte';

export interface PgServer {
  readonly flavor: PgFlavor;
  /** server_version_num of the PostgreSQL the server is, or follows: 170002, 110002. */
  readonly version: number;
}

/** What a session assumes until it knows better: a current PostgreSQL. */
export const CURRENT_POSTGRES: PgServer = { flavor: 'postgres', version: 170_000 };

/** One round trip at session start. */
export const SERVER_SQL = "SELECT version(), current_setting('server_version_num')";

/**
 * Reads version() and server_version_num: `CockroachDB CCL v24.3.6 …` (which says it is
 * PostgreSQL 13), `PostgreSQL 11.2-YB-2024.2.2.1-b0 …`, `PostgreSQL 17.2 on …`.
 */
export function pgServer(versionText: string, versionNumber: string): PgServer {
  const number = Number(versionNumber);
  const version = Number.isInteger(number) && number > 0 ? number : CURRENT_POSTGRES.version;
  const flavor: PgFlavor = /^CockroachDB\b/u.test(versionText)
    ? 'cockroach'
    : versionText.includes('-YB-')
      ? 'yugabyte'
      : 'postgres';
  return { flavor, version };
}

/** `a.attgenerated` (generated columns) came with PostgreSQL 12; before it, nothing is. */
export function generatedColumnSql(server: PgServer = CURRENT_POSTGRES): string {
  return server.version >= 120_000 ? 'a.attgenerated::text' : "''::text";
}

/** CockroachDB has no pg_get_triggerdef, so its triggers cannot be printed back. */
export function printsTriggers(server: PgServer = CURRENT_POSTGRES): boolean {
  return server.flavor !== 'cockroach';
}

/**
 * CockroachDB prints a view's tables with the database in front (`shop.public.orders`),
 * which would tie a dumped view to the database it came from. The database part is left
 * out where it names the view's own database; strings and comments are not touched.
 */
export function withoutDatabase(sql: string, database: string): string {
  const tokens = tokenize(sql, syntaxOf('postgres'));
  const dropped: { start: number; end: number }[] = [];
  tokens.forEach((token, index) => {
    const next = tokens[index + 1];
    const previous = tokens[index - 1];
    if (
      (token.kind === 'word' || token.kind === 'quoted-identifier') &&
      unquoteIdentifier(textOf(sql, token)) === database &&
      next !== undefined &&
      textOf(sql, next) === '.' &&
      (previous === undefined || textOf(sql, previous) !== '.')
    ) {
      dropped.push({ start: token.start, end: next.end });
    }
  });
  let result = sql;
  for (const { start, end } of dropped.reverse()) {
    result = result.slice(0, start) + result.slice(end);
  }
  return result;
}

/** `INSERT INTO t (…) OVERRIDING SYSTEM VALUE VALUES …`: the clause and what follows it. */
const OVERRIDING =
  /^(\s*INSERT\s+INTO\s+(?:"(?:[^"]|"")*"|[^\s(])+\s*\((?:"(?:[^"]|"")*"|[^"()])*\))\s+OVERRIDING\s+SYSTEM\s+VALUE\s+(?=VALUES\b|SELECT\b)/iu;

/**
 * The statement as this server reads it. DataNest's INSERTs of saved rows say OVERRIDING
 * SYSTEM VALUE, which PostgreSQL needs for a GENERATED ALWAYS identity; CockroachDB has no
 * such clause and takes the values of its identity columns as they are, so there it is
 * left out. Everything else goes as written.
 */
export function forServer(sql: string, server: PgServer = CURRENT_POSTGRES): string {
  return server.flavor === 'cockroach' ? sql.replace(OVERRIDING, '$1 ') : sql;
}
