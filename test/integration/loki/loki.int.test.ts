// Grafana Loki for real (V13.25): the group `loki` of docker/compose.yml, one process without
// tenants or sign-in. The lines are pushed here with stamps of the last minutes and a run of
// their own, so every run sees its own data and nobody else's.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteEvent, Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/loki';
import { lokiDialect } from '../../../src/drivers/loki/dialect';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { TEST_LOKI } from '../../helpers/loki-servers';

const BASE = `http://${TEST_LOKI.host}:${TEST_LOKI.port}`;
const RUN = `run${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const SECOND = 1_000_000_000n;

function config(over: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'loki',
    name: 'Loki',
    driver: 'loki',
    host: TEST_LOKI.host,
    port: TEST_LOKI.port,
    ...over,
  };
}

/** Stamps a few seconds apart, ending now, so the lines are inside every window below. */
function stamp(secondsAgo: number): string {
  return (BigInt(Date.now()) * 1_000_000n - BigInt(secondsAgo) * SECOND).toString();
}

async function push(
  streams: { labels: Record<string, string>; lines: [string, string][] }[],
): Promise<void> {
  const response = await fetch(`${BASE}/loki/api/v1/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      streams: streams.map((entry) => ({ stream: entry.labels, values: entry.lines })),
    }),
  });
  if (response.status !== 204) {
    throw new Error(`push failed: ${response.status} ${await response.text()}`);
  }
}

async function run(session: Session, sql: string, rowLimit?: number): Promise<ExecuteEvent[]> {
  const events: ExecuteEvent[] = [];
  for await (const event of session.execute(sql, rowLimit === undefined ? {} : { rowLimit })) {
    events.push(event);
  }
  return events;
}

function rowsOf(events: readonly ExecuteEvent[]): unknown[][] {
  return events.flatMap((event) =>
    event.kind === 'rows' ? event.rows.map((row) => [...row]) : [],
  );
}

function columnsOf(events: readonly ExecuteEvent[]): string[] {
  const first = events.find((event) => event.kind === 'columns');
  return first?.kind === 'columns' ? first.columns.map((column) => column.name) : [];
}

describe('Grafana Loki', () => {
  let session: Session;

  beforeAll(async () => {
    await push([
      {
        labels: { app: `shop_${RUN}`, level: 'info' },
        lines: [
          [stamp(30), 'order 1 created'],
          [stamp(20), 'order 2 created'],
          [stamp(10), 'order 3 created'],
        ],
      },
      {
        labels: { app: `shop_${RUN}`, level: 'error' },
        lines: [[stamp(15), 'payment failed for order 2']],
      },
      {
        labels: { app: `api_${RUN}`, level: 'info' },
        lines: [[stamp(25), '{"msg":"hello","status":200}']],
      },
    ]);
    // Loki serves what it has pushed at once, but the label index follows a moment later.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    session = await driver.openSession(config());
  }, 60_000);

  afterAll(async () => {
    await session.close();
  });

  describe('structure', () => {
    it('lists the labels as tables', async () => {
      const tables = await session.metadata.listTables({});
      expect(tables.map((table) => table.name)).toEqual(expect.arrayContaining(['app', 'level']));
    });

    it('lists the values of a label as its columns', async () => {
      const columns = await session.metadata.listColumns({ name: 'app' });
      expect(columns.map((column) => column.name)).toEqual(
        expect.arrayContaining([`shop_${RUN}`, `api_${RUN}`]),
      );
    });

    it('describes a label as the columns of a log line', async () => {
      const structure = await session.metadata.describeTable({ name: 'app' });
      expect(structure.columns.map((column) => column.name)).toEqual([
        'time',
        'ns',
        'labels',
        'line',
      ]);
    });

    it('finds no values for a label that does not exist', async () => {
      expect(await session.metadata.listColumns({ name: 'no_such_label_here' })).toEqual([]);
    });
  });

  describe('log queries', () => {
    it('reads the lines of a stream, newest first, merged across the streams', async () => {
      const events = await run(session, `{app="shop_${RUN}"}`);
      expect(columnsOf(events)).toEqual(['time', 'ns', 'labels', 'line']);
      expect(rowsOf(events).map((row) => row[3])).toEqual([
        'order 3 created',
        'payment failed for order 2',
        'order 2 created',
        'order 1 created',
      ]);
    });

    it('reads them oldest first when asked', async () => {
      const events = await run(session, `# direction: forward\n{app="shop_${RUN}"}`);
      expect(rowsOf(events).map((row) => row[3])).toEqual([
        'order 1 created',
        'order 2 created',
        'payment failed for order 2',
        'order 3 created',
      ]);
    });

    it('gives each row its labels as JSON and its stamp exactly', async () => {
      const [row] = rowsOf(await run(session, `{app="shop_${RUN}", level="error"}`));
      expect(row?.[2]).toMatchObject({ kind: 'json' });
      const labels = JSON.parse((row?.[2] as { text: string }).text) as Record<string, string>;
      expect(labels).toMatchObject({ app: `shop_${RUN}`, level: 'error' });
      expect((row?.[1] as { text: string }).text).toMatch(/^\d{19}$/u);
    });

    it('filters lines and parses JSON', async () => {
      const filtered = await run(session, `{app="shop_${RUN}"} |= "payment"`);
      expect(rowsOf(filtered).map((row) => row[3])).toEqual(['payment failed for order 2']);
      const parsed = await run(session, `{app="api_${RUN}"} | json | status="200"`);
      expect(rowsOf(parsed)).toHaveLength(1);
    });

    it('stops at the row limit', async () => {
      const events = await run(session, `{app="shop_${RUN}"}`, 2);
      expect(rowsOf(events)).toHaveLength(2);
    });

    it('stops at the limit of a directive and says there was more', async () => {
      const events = await run(session, `# limit: 1\n{app="shop_${RUN}"}`);
      expect(rowsOf(events)).toHaveLength(1);
      const done = events.at(-1);
      expect(done?.kind === 'done' && done.notice).toMatch(/more lines/u);
    });

    it('reads nothing outside the window, and nothing for a stream that is not there', async () => {
      expect(rowsOf(await run(session, `{app="no_such_${RUN}"}`))).toEqual([]);
      // A window that ended an hour ago holds none of the lines pushed just now.
      const old = await run(session, `# range: 30m\n# end: now-1h\n{app="shop_${RUN}"}`);
      expect(rowsOf(old)).toEqual([]);
    });
  });

  describe('metric queries', () => {
    it('counts lines per stream over time', async () => {
      const events = await run(
        session,
        `# range: 10m\n# step: 1m\nsum by (level) (count_over_time({app="shop_${RUN}"}[5m]))`,
      );
      expect(columnsOf(events)).toEqual(['time', 'ns', 'value', 'labels']);
      const rows = rowsOf(events);
      expect(rows.length).toBeGreaterThan(0);
      const levels = new Set(rows.map((row) => (row[3] as { text: string }).text));
      expect(levels).toEqual(new Set(['{"level":"error"}', '{"level":"info"}']));
      expect(typeof rows[0]?.[2]).toBe('number');
    });
  });

  describe('errors', () => {
    it('shows the words of Loki for a query it cannot parse', async () => {
      await expect(run(session, '{app=')).rejects.toMatchObject({
        code: 'syntax',
        message: expect.stringContaining('parse error') as string,
      });
    });

    it('asks for no more lines than the server gives, however many the row limit allows', async () => {
      const events = await run(session, `# limit: 99999\n{app="shop_${RUN}"}`, 99_999);
      expect(rowsOf(events)).toHaveLength(4);
    });

    it('says when nothing listens', async () => {
      await expect(driver.openSession(config({ port: 1 }))).rejects.toMatchObject({
        code: 'connection-failed',
      });
    });

    it('sends a tenant without harm: a server without tenants ignores it', async () => {
      const other = await driver.openSession(config({ database: 'some-tenant' }));
      expect(rowsOf(await run(other, `{app="shop_${RUN}"}`))).toHaveLength(4);
      await other.close();
    });
  });

  describe('a label opened as a table', () => {
    it('pages the lines of a label and counts them', async () => {
      const first = await run(
        session,
        lokiDialect.paginate(`SELECT * FROM ${lokiDialect.quoteTable({ name: 'app' })}`, 2, 0),
        2,
      );
      expect(rowsOf(first)).toHaveLength(2);
      const second = await run(
        session,
        lokiDialect.paginate(`SELECT * FROM ${lokiDialect.quoteTable({ name: 'app' })}`, 2, 2),
        2,
      );
      expect(rowsOf(second)).toHaveLength(2);
      const firstStamps = rowsOf(first).map((row) => (row[1] as { text: string }).text);
      const secondStamps = rowsOf(second).map((row) => (row[1] as { text: string }).text);
      expect(firstStamps.filter((value) => secondStamps.includes(value))).toEqual([]);
      const counted = await run(session, 'SELECT COUNT(*) FROM `app`', 1);
      const total = rowsOf(counted)[0]?.[0];
      expect(typeof total).toBe('number');
      expect(total as number).toBeGreaterThanOrEqual(5);
    });
  });

  describe('cancelling', () => {
    it('stops a request and leaves the session usable', async () => {
      const pending = run(session, `{app="shop_${RUN}"}`).then(
        () => 'finished',
        (error: unknown) => (error as { code?: string }).code,
      );
      await session.cancel();
      // Either it was cancelled in flight, or it had finished already: both leave a working session.
      expect(['cancelled', 'finished']).toContain(await pending);
      expect(rowsOf(await run(session, `{app="api_${RUN}"}`))).toHaveLength(1);
    });
  });
});
