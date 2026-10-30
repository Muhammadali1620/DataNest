// Running EXPLAIN (V8.2): each database asks for its plan in its own words, and some
// servers of one driver differ (MariaDB and TiDB speak MySQL, CockroachDB speaks
// PostgreSQL). The plan comes back as a `QueryPlan`, whatever the server said.

import { DbError } from '../../core/errors';
import { isReadOnlyStatement } from '../../core/sql/read-only';
import { syntaxOf } from '../../core/sql/tokenizer';
import type { Session } from '../../drivers/driver';
import type { CellValue } from '../../shared/cell-value';
import type { SqlDriverId } from '../../shared/connection';
import type { QueryPlan } from '../../shared/query-plan';
import { readClickhousePlan } from './clickhouse-plan';
import { readCockroachPlan } from './cockroach-plan';
import { readMariadbPlan } from './mariadb-plan';
import { readMssqlPlan } from './mssql-plan';
import { readMysqlTree } from './mysql-tree';
import { ORACLE_PLAN_COLUMNS, readOraclePlan } from './oracle-plan';
import { cellText, joinedLines } from './plan-node';
import { readPostgresPlan } from './postgres-plan';
import { readSqlitePlan } from './sqlite-plan';
import { readTabularPlan } from './tabular-plan';

/** Which server of a driver answers: they differ in how they explain. */
export type PlanServer =
  | 'postgres'
  | 'cockroach'
  | 'mysql'
  | 'mysql-old'
  | 'mariadb'
  | 'tidb'
  | 'sqlite'
  | 'mssql'
  | 'clickhouse'
  | 'oracle';

interface ResultSet {
  readonly columns: readonly string[];
  readonly rows: (readonly CellValue[])[];
}

/** Servers that can run the statement and report what really happened. */
const ANALYZE: ReadonlySet<PlanServer> = new Set([
  'postgres',
  'cockroach',
  'mysql',
  'mariadb',
  'tidb',
  'mssql',
]);

export function canAnalyze(server: PlanServer): boolean {
  return ANALYZE.has(server);
}

/** Asks the server who it is, where the driver alone does not tell. */
export async function planServerOf(session: Session, driver: SqlDriverId): Promise<PlanServer> {
  switch (driver) {
    case 'postgres': {
      const version = await firstText(session, 'SELECT version()');
      return /cockroach/iu.test(version) ? 'cockroach' : 'postgres';
    }
    case 'mysql': {
      const version = await firstText(session, 'SELECT VERSION()');
      if (/mariadb/iu.test(version)) {
        return 'mariadb';
      }
      if (/tidb/iu.test(version)) {
        return 'tidb';
      }
      // EXPLAIN ANALYZE and the tree format came with MySQL 8.0.18.
      const [major = 0, minor = 0, patch = 0] = version.split(/[.-]/u).map(Number);
      return major * 10_000 + minor * 100 + patch >= 80_018 ? 'mysql' : 'mysql-old';
    }
    case 'sqlite':
    case 'mssql':
    case 'clickhouse':
    case 'oracle':
      return driver;
  }
}

/**
 * The plan of one statement. With `analyze` the statement really runs, so it is
 * refused for anything that may change data; the caller asks the user first.
 */
export async function explainStatement(
  session: Session,
  server: PlanServer,
  sql: string,
  analyze: boolean,
): Promise<QueryPlan> {
  const statement = sql.trim().replace(/;+\s*$/u, '');
  if (statement === '') {
    throw new DbError('syntax', 'There is no statement to explain');
  }
  if (analyze) {
    if (!canAnalyze(server)) {
      throw new DbError('unsupported', 'This database cannot run a statement for its plan');
    }
    if (!isReadOnlyStatement(statement, syntaxOf(driverOf(server)))) {
      throw new DbError(
        'unsupported',
        'EXPLAIN ANALYZE runs the statement, so DataNest does it only for statements that read',
      );
    }
  }
  switch (server) {
    case 'postgres': {
      const options = analyze ? 'ANALYZE, BUFFERS, FORMAT JSON' : 'FORMAT JSON';
      const [set] = await resultSets(session, `EXPLAIN (${options}) ${statement}`);
      return readPostgresPlan(cellText(set?.rows[0]?.[0]) ?? '', analyze);
    }
    case 'cockroach': {
      const [set] = await resultSets(session, `EXPLAIN ${analyze ? 'ANALYZE ' : ''}${statement}`);
      return readCockroachPlan(joinedLines(set?.rows ?? []), analyze);
    }
    case 'mysql': {
      const [set] = await resultSets(
        session,
        analyze ? `EXPLAIN ANALYZE ${statement}` : `EXPLAIN FORMAT=TREE ${statement}`,
      );
      return readMysqlTree(cellText(set?.rows[0]?.[0]) ?? '', analyze);
    }
    case 'mariadb': {
      const [set] = await resultSets(
        session,
        `${analyze ? 'ANALYZE' : 'EXPLAIN'} FORMAT=JSON ${statement}`,
      );
      return readMariadbPlan(cellText(set?.rows[0]?.[0]) ?? '', analyze);
    }
    case 'tidb':
    case 'mysql-old': {
      const [set] = await resultSets(session, `EXPLAIN ${analyze ? 'ANALYZE ' : ''}${statement}`);
      return readTabularPlan(set?.columns ?? [], set?.rows ?? [], analyze, tableText(set));
    }
    case 'sqlite': {
      const [set] = await resultSets(session, `EXPLAIN QUERY PLAN ${statement}`);
      return readSqlitePlan(set?.rows ?? [], tableText(set));
    }
    case 'mssql':
      return readMssqlPlan(await mssqlPlanXml(session, statement, analyze), analyze);
    case 'clickhouse': {
      const [set] = await resultSets(
        session,
        `EXPLAIN json = 1, indexes = 1, description = 1 ${statement}`,
      );
      return readClickhousePlan(joinedLines(set?.rows ?? []));
    }
    case 'oracle':
      return await oraclePlan(session, statement);
  }
}

/**
 * SET SHOWPLAN_XML (estimated) or SET STATISTICS XML (actual) must stand alone in its
 * batch. The setting is always turned off again, or the editor's session would go
 * on answering every statement with a plan.
 */
async function mssqlPlanXml(
  session: Session,
  statement: string,
  analyze: boolean,
): Promise<string> {
  const option = analyze ? 'STATISTICS XML' : 'SHOWPLAN_XML';
  await resultSets(session, `SET ${option} ON`);
  try {
    const sets = await resultSets(session, statement);
    // With STATISTICS XML the rows of the statement come first, the plan last.
    const plan = [...sets]
      .reverse()
      .find((set) => cellText(set.rows[0]?.[0])?.startsWith('<ShowPlanXML') === true);
    const xml = cellText(plan?.rows[0]?.[0]);
    if (xml === undefined) {
      throw new DbError('internal', 'SQL Server sent no plan for the statement');
    }
    return xml;
  } finally {
    await resultSets(session, `SET ${option} OFF`);
  }
}

/** Plan rows are kept under an id of DataNest's own and deleted when read. */
async function oraclePlan(session: Session, statement: string): Promise<QueryPlan> {
  const id = `DN${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1e6)}`;
  await resultSets(session, `EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR ${statement}`);
  try {
    const [set] = await resultSets(
      session,
      `SELECT ${ORACLE_PLAN_COLUMNS.join(', ')} FROM plan_table WHERE statement_id = '${id}' ORDER BY id`,
    );
    return readOraclePlan(set?.columns ?? [], set?.rows ?? [], tableText(set));
  } finally {
    await resultSets(session, `DELETE FROM plan_table WHERE statement_id = '${id}'`);
  }
}

function driverOf(server: PlanServer): SqlDriverId {
  switch (server) {
    case 'cockroach':
      return 'postgres';
    case 'mysql-old':
    case 'mariadb':
    case 'tidb':
      return 'mysql';
    case 'postgres':
    case 'mysql':
    case 'sqlite':
    case 'mssql':
    case 'clickhouse':
    case 'oracle':
      return server;
  }
}

async function firstText(session: Session, sql: string): Promise<string> {
  const [set] = await resultSets(session, sql);
  return cellText(set?.rows[0]?.[0]) ?? '';
}

/** Every set of rows a statement returns, the way the plan readers want them. */
export async function resultSets(session: Session, sql: string): Promise<ResultSet[]> {
  const sets: { columns: string[]; rows: (readonly CellValue[])[] }[] = [];
  for await (const event of session.execute(sql)) {
    if (event.kind === 'columns') {
      sets.push({ columns: event.columns.map((column) => column.name), rows: [] });
    } else if (event.kind === 'rows') {
      sets.at(-1)?.rows.push(...event.rows);
    }
  }
  return sets;
}

/** Rows as tab-separated text, for "Show the original" of plans that came as a table. */
function tableText(set: ResultSet | undefined): string {
  if (set === undefined) {
    return '';
  }
  return [set.columns, ...set.rows.map((row) => row.map((cell) => cellText(cell) ?? 'NULL'))]
    .map((line) => line.join('\t'))
    .join('\n');
}
