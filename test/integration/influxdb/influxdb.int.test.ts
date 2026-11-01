// InfluxDB 2.x for real (V13.20): the group `influxdb` of docker/compose.yml, one
// organization, one bucket and a known admin token. The points are written here, with fixed
// times, so every run sees the same data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecuteEvent, Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/influxdb';
import { influxdbDialect } from '../../../src/drivers/influxdb/dialect';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { TEST_INFLUXDB } from '../../helpers/influxdb-servers';

const BASE = `http://${TEST_INFLUXDB.host}:${TEST_INFLUXDB.port}`;

function config(over: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'influx',
    name: 'Influx',
    driver: 'influxdb',
    host: TEST_INFLUXDB.host,
    port: TEST_INFLUXDB.port,
    user: TEST_INFLUXDB.org,
    password: TEST_INFLUXDB.token,
    database: TEST_INFLUXDB.bucket,
    ...over,
  };
}

async function write(lines: string[]): Promise<void> {
  const response = await fetch(
    `${BASE}/api/v2/write?org=${TEST_INFLUXDB.org}&bucket=${TEST_INFLUXDB.bucket}&precision=s`,
    {
      method: 'POST',
      headers: { authorization: `Token ${TEST_INFLUXDB.token}` },
      body: lines.join('\n'),
    },
  );
  if (response.status !== 204) {
    throw new Error(`write failed: ${response.status} ${await response.text()}`);
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

describe('InfluxDB 2.x', () => {
  let session: Session;

  beforeAll(async () => {
    await write([
      'cpu,host=a,region=eu usage=1.5,idle=98i 1714557600',
      'cpu,host=a,region=eu usage=2.5,idle=97i 1714557660',
      'cpu,host=b,region=us usage=3.5,idle=96i 1714557600',
      'mem,host=a used=9007199254740993i,note="hi there",ok=true 1714557600',
    ]);
    session = await driver.openSession(config());
  });

  afterAll(async () => {
    await session.close();
  });

  describe('structure', () => {
    it('lists the buckets as databases', async () => {
      const databases = await session.metadata.listDatabases();
      expect(databases).toContain(TEST_INFLUXDB.bucket);
      expect(databases).toContain('_monitoring');
    });

    it('lists the measurements of a bucket', async () => {
      const tables = await session.metadata.listTables({ database: TEST_INFLUXDB.bucket });
      expect(tables.map((table) => table.name)).toEqual(['cpu', 'mem']);
    });

    it('lists time, tags and fields as columns', async () => {
      const columns = await session.metadata.listColumns({
        database: TEST_INFLUXDB.bucket,
        name: 'cpu',
      });
      expect(columns.map((column) => `${column.name}:${column.dataType}`)).toEqual([
        'time:dateTime',
        'host:tag',
        'region:tag',
        'idle:field',
        'usage:field',
      ]);
    });

    it('describes a measurement, and finds none in a bucket that does not exist', async () => {
      const structure = await session.metadata.describeTable({
        database: TEST_INFLUXDB.bucket,
        name: 'mem',
      });
      expect(structure.columns.map((column) => column.name)).toEqual([
        'time',
        'host',
        'note',
        'ok',
        'used',
      ]);
      await expect(
        session.metadata.listTables({ database: 'no-such-bucket' }),
      ).rejects.toMatchObject({
        name: 'DbError',
      });
    });
  });

  describe('Flux', () => {
    const FLUX = `from(bucket: "metrics")
  |> range(start: 2024-01-01T00:00:00Z, stop: 2025-01-01T00:00:00Z)
  |> filter(fn: (r) => r._measurement == "cpu" and r._field == "usage")
  |> sort(columns: ["host", "_time"])`;

    it('returns typed columns and rows, times as times', async () => {
      const events = await run(session, FLUX);
      const columns = events.find((event) => event.kind === 'columns');
      expect(columns?.kind === 'columns' ? columns.columns : []).toEqual(
        expect.arrayContaining([
          { name: '_time', dataType: 'dateTime' },
          { name: '_value', dataType: 'double' },
          { name: 'host', dataType: 'string' },
        ]),
      );
      const names = columnsOf(events);
      const rows = rowsOf(events);
      expect(rows).toHaveLength(3);
      const at = (name: string): number => names.indexOf(name);
      expect(rows.map((row) => row[at('_value')])).toEqual([1.5, 2.5, 3.5]);
      expect(rows[0]?.[at('_time')]).toEqual({ kind: 'datetime', text: '2024-05-01T10:00:00Z' });
      expect(rows.map((row) => row[at('host')])).toEqual(['a', 'a', 'b']);
      expect(events.at(-1)).toEqual({ kind: 'done' });
    });

    it('keeps integers beyond 2^53 whole', async () => {
      const events = await run(
        session,
        `from(bucket: "metrics") |> range(start: 2024-01-01T00:00:00Z, stop: 2025-01-01T00:00:00Z)
  |> filter(fn: (r) => r._measurement == "mem" and r._field == "used") |> keep(columns: ["_value"])`,
      );
      const names = columnsOf(events);
      expect(rowsOf(events).map((row) => row[names.indexOf('_value')])).toEqual([
        { kind: 'bigint', text: '9007199254740993' },
      ]);
    });

    it('reads booleans and text fields', async () => {
      const events = await run(
        session,
        `from(bucket: "metrics") |> range(start: 2024-01-01T00:00:00Z, stop: 2025-01-01T00:00:00Z)
  |> filter(fn: (r) => r._measurement == "mem" and (r._field == "ok" or r._field == "note"))
  |> keep(columns: ["_field", "_value"]) |> sort(columns: ["_field"])`,
      );
      const names = columnsOf(events);
      expect(
        rowsOf(events).map((row) => [row[names.indexOf('_field')], row[names.indexOf('_value')]]),
      ).toEqual([
        ['note', 'hi there'],
        ['ok', true],
      ]);
    });

    it('merges the tables of one shape, and says what it left out', async () => {
      // `idle` is an integer and `usage` a float: the same columns, so one result.
      const all = await run(
        session,
        `from(bucket: "metrics") |> range(start: 2024-01-01T00:00:00Z, stop: 2025-01-01T00:00:00Z)
  |> filter(fn: (r) => r._measurement == "cpu")`,
      );
      expect(rowsOf(all)).toHaveLength(6);
      // A result with other columns cannot join the grid: it is left out, and counted.
      const mixed = await run(
        session,
        `base = from(bucket: "metrics") |> range(start: 2024-01-01T00:00:00Z, stop: 2025-01-01T00:00:00Z)
base |> filter(fn: (r) => r._measurement == "cpu" and r._field == "usage") |> keep(columns: ["_value"]) |> yield(name: "a")
base |> filter(fn: (r) => r._measurement == "mem") |> keep(columns: ["host"]) |> yield(name: "b")`,
      );
      const done = mixed.at(-1);
      expect(done?.kind === 'done' ? done.notice : undefined).toContain('left out');
      expect(columnsOf(mixed)).toContain('_value');
    });

    it('stops at the row limit and tells the server to stop', async () => {
      const events = await run(
        session,
        `import "generate"
generate.from(count: 5000000, fn: (n) => n, start: 2020-01-01T00:00:00Z, stop: 2021-01-01T00:00:00Z)`,
        500,
      );
      expect(rowsOf(events)).toHaveLength(500);
      expect(events.at(-1)).toEqual({ kind: 'done' });
    });

    it('returns nothing but done for an empty result', async () => {
      const events = await run(
        session,
        'from(bucket: "metrics") |> range(start: 2001-01-01T00:00:00Z, stop: 2001-01-02T00:00:00Z)',
      );
      expect(events).toEqual([{ kind: 'done' }]);
    });

    it('reports a syntax error as one', async () => {
      await expect(run(session, 'from(bucket: ) |> range(')).rejects.toMatchObject({
        name: 'DbError',
        code: 'syntax',
      });
    });

    it('reports a bucket that does not exist as not found', async () => {
      await expect(
        run(session, 'from(bucket: "no-such-bucket") |> range(start: -1h)'),
      ).rejects.toMatchObject({ code: 'not-found' });
    });

    it('can be cancelled while the server is working, and the session lives on', async () => {
      const running = run(
        session,
        `import "generate"
generate.from(count: 2000000000, fn: (n) => n, start: 2000-01-01T00:00:00Z, stop: 2020-01-01T00:00:00Z)
  |> sort(columns: ["_value"])`,
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await session.cancel();
      await expect(running).rejects.toMatchObject({ code: 'cancelled' });
      expect(rowsOf(await run(session, FLUX))).toHaveLength(3);
    });
  });

  describe('InfluxQL', () => {
    it('reads a measurement as the table viewer does: quoted name, LIMIT and OFFSET', async () => {
      const sql = influxdbDialect.paginate(
        `SELECT * FROM ${influxdbDialect.quoteTable({ name: 'cpu' })}`,
        2,
        1,
      );
      expect(sql).toBe('SELECT * FROM "cpu" LIMIT 2 OFFSET 1');
      const events = await run(session, sql);
      expect(columnsOf(events)).toEqual(['time', 'host', 'idle', 'region', 'usage']);
      expect(rowsOf(events)).toHaveLength(2);
    });

    it('filters and orders', async () => {
      const events = await run(
        session,
        `SELECT usage, host FROM "cpu" WHERE host = ${influxdbDialect.literal('a')} ORDER BY time DESC`,
      );
      expect(rowsOf(events)).toEqual([
        [{ kind: 'datetime', text: '2024-05-01T10:01:00Z' }, 2.5, 'a'],
        [{ kind: 'datetime', text: '2024-05-01T10:00:00Z' }, 1.5, 'a'],
      ]);
    });

    it('groups by a tag: the tag comes back as a column', async () => {
      const events = await run(session, 'SELECT mean(usage) FROM "cpu" GROUP BY host');
      expect(columnsOf(events)).toEqual(['time', 'mean', 'host']);
      expect(rowsOf(events).map((row) => [row[1], row[2]])).toEqual([
        [2, 'a'],
        [3.5, 'b'],
      ]);
    });

    it('runs SHOW statements', async () => {
      const events = await run(session, 'SHOW MEASUREMENTS');
      expect(rowsOf(events)).toEqual([['cpu'], ['mem']]);
    });

    it('reports a syntax error as one', async () => {
      await expect(run(session, 'SELECT FROM')).rejects.toMatchObject({ code: 'syntax' });
    });
  });

  describe('sign-in and policies', () => {
    it('refuses a wrong token', async () => {
      await expect(driver.openSession(config({ password: 'nope' }))).rejects.toMatchObject({
        code: 'auth-failed',
      });
    });

    it('says an organization that does not exist is not found', async () => {
      await expect(driver.openSession(config({ user: 'nobody' }))).rejects.toMatchObject({
        name: 'DbError',
      });
    });

    it('says nothing listens at a wrong port', async () => {
      await expect(driver.openSession(config({ port: 1 }))).rejects.toMatchObject({
        code: 'connection-failed',
      });
    });

    it('refuses writes on a read-only connection, before they are sent', async () => {
      const readOnly = await driver.openSession(config({ readOnly: true }));
      await expect(run(readOnly, 'DROP MEASUREMENT "cpu"')).rejects.toMatchObject({
        code: 'permission-denied',
      });
      await expect(
        run(readOnly, 'from(bucket: "metrics") |> range(start: -1h) |> to(bucket: "x")'),
      ).rejects.toMatchObject({ code: 'permission-denied' });
      expect((await run(readOnly, 'SHOW MEASUREMENTS')).length).toBeGreaterThan(0);
      await readOnly.close();
    });
  });
});
