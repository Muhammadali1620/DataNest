import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { driver } from '../../../../src/drivers/loki';
import type { Session } from '../../../../src/drivers/driver';
import { FakeLoki } from '../../../helpers/fake-loki';

let server: FakeLoki;
let session: Session;

async function open(): Promise<Session> {
  return await driver.openSession({
    id: 'c',
    name: 'Loki',
    driver: 'loki',
    host: '127.0.0.1',
    port: server.port,
  });
}

beforeEach(async () => {
  server = new FakeLoki({
    labels: ['service_name', 'app', 'level', 'app'],
    values: {
      app: ['shop', 'api', '', 'shop', 'worker'],
      level: ['info', 'error'],
      many: Array.from({ length: 800 }, (_, index) => `v${String(index).padStart(4, '0')}`),
    },
  });
  await server.start();
  session = await open();
});

afterEach(async () => {
  await session.close();
  await server.stop();
});

describe('Loki metadata', () => {
  it('has no databases or schemas', async () => {
    expect(await session.metadata.listDatabases()).toEqual([]);
    expect(await session.metadata.listSchemas()).toEqual([]);
  });

  it('lists the labels as tables, sorted and without repeats', async () => {
    const tables = await session.metadata.listTables({});
    expect(tables).toEqual([
      { name: 'app', kind: 'table' },
      { name: 'level', kind: 'table' },
      { name: 'service_name', kind: 'table' },
    ]);
  });

  it('asks for a day of labels at least', async () => {
    await session.metadata.listTables({});
    const call = server.calls('/loki/api/v1/labels').at(-1);
    const span = BigInt(call?.query.end ?? '0') - BigInt(call?.query.start ?? '0');
    expect(span).toBe(86_400_000_000_000n);
  });

  it('asks for a longer window when the session range is longer than a day', async () => {
    for await (const _ of session.execute('# range: 7d')) {
      // Only the default is set.
    }
    await session.metadata.listTables({});
    const call = server.calls('/loki/api/v1/labels').at(-1);
    const span = BigInt(call?.query.end ?? '0') - BigInt(call?.query.start ?? '0');
    expect(span).toBe(7n * 86_400_000_000_000n);
  });

  it('lists the values of a label as its columns, sorted, without blanks and repeats', async () => {
    const columns = await session.metadata.listColumns({ name: 'app' });
    expect(columns.map((column) => column.name)).toEqual(['api', 'shop', 'worker']);
    expect(columns[0]).toEqual({
      name: 'api',
      dataType: 'value',
      nullable: false,
      primaryKey: false,
    });
  });

  it('cuts the values of a label at 500', async () => {
    const columns = await session.metadata.listColumns({ name: 'many' });
    expect(columns).toHaveLength(500);
  });

  it('puts the name of the label in the path, safely', async () => {
    await session.metadata.listColumns({ name: 'a/b c' });
    expect(server.received.at(-1)?.path).toBe('/loki/api/v1/label/a%2Fb%20c/values');
  });

  it('describes a label as the four columns of a log line, with no key', async () => {
    const structure = await session.metadata.describeTable({ name: 'app' });
    expect(structure.columns.map((column) => `${column.name}:${column.dataType}`)).toEqual([
      'time:datetime',
      'ns:bigint',
      'labels:json',
      'line:text',
    ]);
    expect(structure.primaryKey).toEqual([]);
    expect(structure.indexes).toEqual([]);
  });

  it('has no keys, indexes, routines or types, and no definitions or dumps', async () => {
    expect(await session.metadata.listUniqueKeys({ name: 'app' })).toEqual([]);
    expect(await session.metadata.listForeignKeys({ name: 'app' })).toEqual([]);
    expect(await session.metadata.listIndexes({ name: 'app' })).toEqual([]);
    expect(await session.metadata.listObjects({}, 'function')).toEqual([]);
    expect(await session.metadata.listTypeDumps({})).toEqual([]);
    await expect(
      session.metadata.getDefinition({ kind: 'function', name: 'f' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(session.metadata.getTableDump({ name: 'app' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
