import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { driver } from '../../../../src/drivers/influxdb';
import { influxdbDialect } from '../../../../src/drivers/influxdb/dialect';
import { fluxString } from '../../../../src/drivers/influxdb/metadata';
import type { Session } from '../../../../src/drivers/driver';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeInflux, fluxTable } from '../../../helpers/fake-influx';

let server: FakeInflux;
let session: Session;

const names = (values: readonly string[]): string =>
  fluxTable(
    ['result', 'table', '_value'],
    ['string', 'long', 'string'],
    values.map((value) => ['', '0', value]),
    ['_result', '', ''],
  );

async function connect(over: Partial<ResolvedConnectionConfig> = {}): Promise<Session> {
  return await driver.openSession({
    id: 'c',
    name: 'Influx',
    driver: 'influxdb',
    host: '127.0.0.1',
    port: server.port,
    user: 'acme',
    password: 't',
    database: 'metrics',
    ...over,
  });
}

beforeEach(async () => {
  server = new FakeInflux({
    token: 't',
    buckets: [{ name: 'zeta' }, { name: 'metrics' }, { name: '_tasks' }],
  });
  await server.start();
  server.flux('schema.measurements', { body: names(['mem', 'cpu', 'cpu']) });
  server.flux('measurementTagKeys', { body: names(['host', '_field', '_measurement', 'region']) });
  server.flux('measurementFieldKeys', { body: names(['usage', 'idle']) });
  session = await connect();
});

afterEach(async () => {
  await session.close();
  await server.stop();
});

describe('InfluxMetadata', () => {
  it('lists the buckets as databases, sorted', async () => {
    expect(await session.metadata.listDatabases()).toEqual(['_tasks', 'metrics', 'zeta']);
    const call = server.received.filter((item) => item.path === '/api/v2/buckets').at(-1);
    expect(call?.query).toMatchObject({ org: 'acme', limit: '100', offset: '0' });
  });

  it('reads every page of buckets', async () => {
    await server.stop();
    const many = Array.from({ length: 230 }, (_, index) => ({
      name: `b${String(index).padStart(3, '0')}`,
    }));
    server = new FakeInflux({ token: 't', buckets: many });
    await server.start();
    await session.close();
    session = await connect();
    const listed = await session.metadata.listDatabases();
    expect(listed).toHaveLength(230);
    expect(listed[0]).toBe('b000');
  });

  it('has no schemas', async () => {
    expect(await session.metadata.listSchemas()).toEqual([]);
  });

  it('lists the measurements of a bucket, once each and sorted', async () => {
    const tables = await session.metadata.listTables({ database: 'zeta' });
    expect(tables).toEqual([
      { name: 'cpu', kind: 'table' },
      { name: 'mem', kind: 'table' },
    ]);
    const query = JSON.parse(server.last()?.body ?? '{}') as { query: string };
    expect(query.query).toContain('schema.measurements(bucket: "zeta")');
    expect(query.query).toContain('import "influxdata/influxdb/schema"');
  });

  it('falls back to the bucket of the connection', async () => {
    await session.metadata.listTables({});
    const query = JSON.parse(server.last()?.body ?? '{}') as { query: string };
    expect(query.query).toContain('bucket: "metrics"');
  });

  it('needs a bucket from somewhere', async () => {
    await session.close();
    session = await connect({ database: undefined });
    await expect(session.metadata.listTables({})).rejects.toMatchObject({ code: 'not-found' });
  });

  it('lists time, then tags, then fields as columns, without the server’s own tags', async () => {
    const columns = await session.metadata.listColumns({ database: 'metrics', name: 'cpu' });
    expect(columns).toEqual([
      { name: 'time', dataType: 'dateTime', nullable: false, primaryKey: true },
      { name: 'host', dataType: 'tag', nullable: true, primaryKey: false },
      { name: 'region', dataType: 'tag', nullable: true, primaryKey: false },
      { name: 'idle', dataType: 'field', nullable: true, primaryKey: false },
      { name: 'usage', dataType: 'field', nullable: true, primaryKey: false },
    ]);
  });

  it('asks the whole history, and quotes the names it sends', async () => {
    await session.metadata.listColumns({ name: 'we"ird${x}\\' });
    const queries = server.received
      .filter((item) => item.path === '/api/v2/query')
      .map((item) => (JSON.parse(item.body) as { query: string }).query);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      expect(query).toContain('start: 1970-01-01T00:00:00Z');
      expect(query).toContain('measurement: "we\\"ird\\${x}\\\\"');
    }
  });

  it('describes a table as its columns, with nothing to identify a row', async () => {
    const structure = await session.metadata.describeTable({ name: 'cpu' });
    expect(structure.columns.map((column) => column.name)).toEqual([
      'time',
      'host',
      'region',
      'idle',
      'usage',
    ]);
    expect(structure.primaryKey).toEqual([]);
    expect(structure.indexes).toEqual([]);
    expect(structure.foreignKeys).toEqual([]);
  });

  it('has no keys, indexes, routines, types or dumps', async () => {
    const table = { name: 'cpu' };
    expect(await session.metadata.listUniqueKeys(table)).toEqual([]);
    expect(await session.metadata.listForeignKeys(table)).toEqual([]);
    expect(await session.metadata.listIndexes(table)).toEqual([]);
    expect(await session.metadata.listObjects({}, 'function')).toEqual([]);
    expect(await session.metadata.listTypeDumps({})).toEqual([]);
    await expect(
      session.metadata.getDefinition({ kind: 'table', name: 'cpu' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(session.metadata.getTableDump(table)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});

describe('fluxString', () => {
  it('escapes the quote, the backslash and an interpolation', () => {
    expect(fluxString('plain')).toBe('"plain"');
    expect(fluxString('a"b')).toBe('"a\\"b"');
    expect(fluxString('a\\b')).toBe('"a\\\\b"');
    expect(fluxString('${evil}')).toBe('"\\${evil}"');
  });
});

describe('the InfluxQL dialect', () => {
  const d = influxdbDialect;

  it('quotes names with a backslash escape, and a table by its name alone', () => {
    expect(d.quoteIdentifier('cpu')).toBe('"cpu"');
    expect(d.quoteIdentifier('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(d.quoteTable({ database: 'metrics', name: 'cpu' })).toBe('"cpu"');
  });

  it('writes literals', () => {
    expect(d.literal("it's")).toBe("'it\\'s'");
    expect(d.literal(5)).toBe('5');
    expect(d.literal(true)).toBe('true');
    expect(d.literal(Number.POSITIVE_INFINITY)).toBe("'Infinity'");
    expect(d.literal({ kind: 'bigint', text: '123' })).toBe('123');
    expect(d.literal({ kind: 'decimal', text: 'x' })).toBe("'x'");
    expect(d.literal({ kind: 'datetime', text: '2024-05-01T10:00:00Z' })).toBe(
      "'2024-05-01T10:00:00Z'",
    );
    expect(d.literal({ kind: 'json', text: '{}' })).toBe("'{}'");
    expect(d.literal({ kind: 'binary', size: 1, preview: 'ff' })).toBe("'ff'");
    expect(() => d.literal(null)).toThrow(/NULL/);
  });

  it('pages with LIMIT and OFFSET', () => {
    expect(d.paginate('SELECT * FROM "cpu";', 100, 0)).toBe('SELECT * FROM "cpu" LIMIT 100');
    expect(d.paginate('SELECT * FROM "cpu"', 100, 200)).toBe(
      'SELECT * FROM "cpu" LIMIT 100 OFFSET 200',
    );
    expect(() => d.paginate('SELECT 1', -1, 0)).toThrow();
    expect(() => d.paginate('SELECT 1', 1, 1.5)).toThrow();
  });

  it('offers no designer, no dump, no LIKE', () => {
    expect(d.ddl.designer.types).toEqual([]);
    expect(() => d.ddl.createTable({ name: 'x' }, {} as never)).toThrow(/InfluxDB/);
    expect(() => d.likeText('"a"', "'%x%'")).toThrow(/InfluxDB/);
    expect(() => d.insertDefaultRow('"cpu"')).toThrow(/InfluxDB/);
    expect(() => d.dump.insert('"cpu"', [], [], false)).toThrow(/InfluxDB/);
    expect(d.ddl.dropRelation({ name: 'cpu' }, 'table')).toBe('DROP MEASUREMENT "cpu"');
  });

  it('has keywords of InfluxQL', () => {
    expect(d.keywords).toContain('SELECT');
    expect(d.keywords).toContain('SHOW MEASUREMENTS');
  });
});
