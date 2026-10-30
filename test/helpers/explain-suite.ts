// The checks of EXPLAIN (V8.2) every real server goes through: an estimated plan of a
// join over the seed tables, the real one where the server can run the statement,
// and an editor session that still answers normally afterwards.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../src/drivers/driver';
import {
  canAnalyze,
  explainStatement,
  type PlanServer,
  planServerOf,
} from '../../src/services/explain/explain';
import type { ResolvedConnectionConfig, SqlDriverId } from '../../src/shared/connection';
import { planNodes, planRows, type QueryPlan } from '../../src/shared/query-plan';
import { ORACLE_SERVICE, testDatabase, type TestDatabaseId } from './databases';
import { firstColumn, runAll } from './driver-run';

/** Without aliases, so every server names the tables it reads. */
export const EXPLAINED_JOIN =
  "SELECT customers.full_name, COUNT(*) AS n FROM customers JOIN orders ON orders.customer_id = customers.id WHERE customers.country <> 'XX' GROUP BY customers.full_name ORDER BY n DESC";

export function serverConfig(id: TestDatabaseId, driver: SqlDriverId): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `explain-${id}`,
    name: id,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: id === 'oracle' ? ORACLE_SERVICE : db.database,
  };
}

/** Every table name the plan reads, lower case. */
function objectsOf(plan: QueryPlan): string {
  return planNodes(plan)
    .map((node) => `${node.object ?? ''} ${node.detail ?? ''}`)
    .join(' ')
    .toLowerCase();
}

export function explainSuite(options: {
  readonly label: string;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  readonly server: PlanServer;
  readonly sqlDriver: SqlDriverId;
  /** The join to explain; the seed join by default. */
  readonly statement?: string;
  /** A statement that changes data; absent where EXPLAIN takes only SELECT (ClickHouse). */
  readonly change?: string;
  /** Run once first, where the seed tables are not there already (SQLite). */
  readonly setup?: readonly string[];
}): void {
  describe(`EXPLAIN on ${options.label}`, () => {
    let session: Session;
    const statement = options.statement ?? EXPLAINED_JOIN;

    beforeAll(async () => {
      session = await options.driver().openSession(options.config());
      for (const sql of options.setup ?? []) {
        await runAll(session, sql);
      }
    }, 60_000);

    afterAll(async () => {
      await session.close();
    });

    it('knows which server it talks to', async () => {
      expect(await planServerOf(session, options.sqlDriver)).toBe(options.server);
    });

    it('gives the estimated plan as a tree that reads both tables', async () => {
      const plan = await explainStatement(session, options.server, statement, false);
      expect(plan.analyzed).toBe(false);
      expect(planNodes(plan).length).toBeGreaterThan(1);
      const objects = objectsOf(plan);
      expect(objects).toContain('customers');
      expect(objects).toContain('orders');
      expect(plan.raw.length).toBeGreaterThan(0);
      expect(() => planRows(plan)).not.toThrow();
    });

    const { change } = options;
    if (canAnalyze(options.server) && change !== undefined) {
      it('runs the statement for the real plan', async () => {
        const plan = await explainStatement(session, options.server, statement, true);
        expect(plan.analyzed).toBe(true);
        expect(planNodes(plan).some((node) => node.actualRows !== undefined)).toBe(true);
      });

      it('refuses to run a statement that changes data', async () => {
        await expect(explainStatement(session, options.server, change, true)).rejects.toMatchObject(
          { code: 'unsupported' },
        );
      });
    }

    it.runIf(change !== undefined)('explains a change without making it', async () => {
      const plan = await explainStatement(session, options.server, change ?? '', false);
      expect(planNodes(plan).length).toBeGreaterThan(0);
      const [count] = firstColumn(await runAll(session, 'SELECT COUNT(*) FROM customers'));
      const text =
        typeof count === 'object' && count !== null && 'text' in count ? count.text : count;
      expect(Number(text)).toBeGreaterThan(0);
    });

    it('reports the error of a statement the server cannot plan', async () => {
      await expect(
        explainStatement(session, options.server, 'SELECT * FROM no_such_table_for_explain', false),
      ).rejects.toThrow();
    });

    it('leaves the session answering statements as usual', async () => {
      const result = await runAll(
        session,
        options.server === 'oracle' ? 'SELECT 1 AS one FROM dual' : 'SELECT 1 AS one',
      );
      expect(
        result.columnSets.map((set) => set.map((column) => column.name.toLowerCase())),
      ).toEqual([['one']]);
    });
  });
}
