import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { TableStructure } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { INSERT_ROWS } from '../../../src/services/dump-script';
import { type DumpRequest, SqlDumper } from '../../../src/services/sql-dump';
import type { CellValue } from '../../../src/shared/cell-value';
import { FakeDriver, FakeSession } from '../../helpers/fake-driver';
import { RecordingLogger } from '../../helpers/fakes';

class MemorySink {
  text = '';

  write(text: string): Promise<void> {
    this.text += text;
    return Promise.resolve();
  }
}

const STRUCTURE: TableStructure = {
  columns: [
    { name: 'id', dataType: 'int', nullable: false, autoIncrement: true, generated: false },
    { name: 'name', dataType: 'text', nullable: true, autoIncrement: false, generated: false },
    { name: 'twice', dataType: 'int', nullable: true, autoIncrement: false, generated: true },
  ],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [],
};

class Harness {
  readonly driver = new FakeDriver('postgres');
  readonly session = new FakeSession({ id: 'c', name: 'c', driver: 'postgres' });
  readonly released: string[] = [];
  readonly sink = new MemorySink();
  rows: CellValue[][] = [
    [1, "O'Brien"],
    [2, null],
  ];

  constructor() {
    const metadata = this.session.metadata;
    metadata.structure = STRUCTURE;
    metadata.tableDumps.set('orders', {
      before: ['CREATE SEQUENCE orders_id_seq'],
      create: ['CREATE TABLE orders (…)'],
      after: ['ALTER TABLE orders ADD CONSTRAINT fk', 'CREATE TRIGGER tr'],
      owns: [{ kind: 'sequence', name: 'orders_id_seq' }],
    });
    metadata.tableDumps.set('items', {
      before: [],
      create: ['CREATE TABLE items (…)'],
      after: [],
      owns: [],
    });
    metadata.definitions.set('view:top', ['CREATE VIEW top AS SELECT * FROM base']);
    metadata.definitions.set('view:base', ['CREATE VIEW base AS SELECT * FROM orders']);
    metadata.definitions.set('function:total', ['CREATE FUNCTION total() …']);
    metadata.definitions.set('sequence:invoice_seq', [
      'CREATE SEQUENCE invoice_seq',
      'ALTER SEQUENCE invoice_seq OWNED BY gone.id',
    ]);
    metadata.objects = [
      { kind: 'function', name: 'total' },
      { kind: 'sequence', name: 'orders_id_seq' },
      { kind: 'sequence', name: 'invoice_seq' },
    ];
    metadata.typeDumps = [{ name: 'mood', create: 'CREATE TYPE mood', drop: 'DROP TYPE mood' }];
    this.session.rowsFor = (sql) => (sql.startsWith('SELECT') ? this.rows : undefined);
    // Like PostgreSQL: routines first, schemas created when missing.
    this.driver.dialect = {
      ...this.driver.dialect,
      dump: {
        ...this.driver.dialect.dump,
        routinesFirst: true,
        createSchema: (name) => `CREATE SCHEMA ${name}`,
      },
    };
    this.driver.capabilities = {
      ...this.driver.capabilities,
      objectKinds: ['function', 'procedure', 'trigger', 'sequence'],
    };
  }

  dumper(): SqlDumper {
    return new SqlDumper({
      manager: {
        driverOf: () => Promise.resolve(this.driver as Driver),
        acquire: () => Promise.resolve(this.session as Session),
        release: (owner) => {
          this.released.push(owner);
          return Promise.resolve();
        },
      },
      logger: new RecordingLogger(),
      now: () => new Date('2026-10-29T10:00:00Z'),
    });
  }

  request(overrides: Partial<DumpRequest> = {}): DumpRequest {
    return {
      target: { connectionId: 'c', database: 'shop' },
      scope: { database: 'shop', schema: 'sales' },
      relations: [
        { name: 'orders', kind: 'table' },
        { name: 'top', kind: 'view' },
        { name: 'base', kind: 'view' },
      ],
      wholeScope: true,
      content: 'all',
      dropFirst: true,
      sink: this.sink,
      source: 'Local / shop',
      ...overrides,
    };
  }

  /** Where each piece first appears in the script. */
  at(piece: string): number {
    const index = this.sink.text.indexOf(piece);
    expect(index, piece).toBeGreaterThanOrEqual(0);
    return index;
  }
}

describe('SqlDumper', () => {
  it('reads in a snapshot on its own session and lets it go', async () => {
    const harness = new Harness();
    await harness.dumper().dump(harness.request());
    const executed = harness.session.executed;
    expect(executed.slice(0, 2)).toEqual(['PREPARE READ', 'BEGIN SNAPSHOT']);
    expect(executed.at(-1)).toBe('END SNAPSHOT');
    expect(harness.released).toHaveLength(1);
    expect(harness.released[0]).toMatch(/^task:dump-/u);
  });

  it('writes the sections in an order that loads into an empty database', async () => {
    const harness = new Harness();
    const report = await harness.dumper().dump(harness.request());
    const order = [
      '-- DataNest dump',
      'HEADER 1;',
      'DROP VIEW IF EXISTS "top", "base";',
      'DROP TABLE IF EXISTS "orders";',
      'DROP FUNCTION IF EXISTS "total";',
      'DROP SEQUENCE IF EXISTS "invoice_seq";',
      'DROP TYPE mood;',
      'CREATE SCHEMA sales;',
      'CREATE TYPE mood;',
      'CREATE FUNCTION total() …;',
      'CREATE SEQUENCE invoice_seq;',
      'CREATE SEQUENCE orders_id_seq;',
      'CREATE TABLE orders (…);',
      'INSERT INTO "orders"',
      'RESET orders.id;',
      'ALTER TABLE orders ADD CONSTRAINT fk;',
      'CREATE TRIGGER tr;',
      'CREATE VIEW base',
      'CREATE VIEW top',
      'FOOTER;',
    ];
    const positions = order.map((piece) => harness.at(piece));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(report).toMatchObject({ tables: 1, views: 2, objects: 3, rows: 2, skipped: [] });
  });

  it('puts routines after the views where the dialect wants them last', async () => {
    const harness = new Harness();
    harness.driver.dialect = {
      ...harness.driver.dialect,
      dump: { ...harness.driver.dialect.dump, routinesFirst: false },
    };
    await harness.dumper().dump(harness.request());
    expect(harness.at('CREATE FUNCTION total()')).toBeGreaterThan(harness.at('CREATE VIEW top'));
  });

  it('leaves out sequences a dumped table owns, and the owner of the others', async () => {
    const harness = new Harness();
    await harness.dumper().dump(harness.request());
    expect(harness.sink.text.match(/CREATE SEQUENCE orders_id_seq/gu)).toHaveLength(1);
    expect(harness.sink.text).not.toContain('OWNED BY gone.id');
  });

  it('writes rows without generated columns, with identity and sequences', async () => {
    const harness = new Harness();
    await harness.dumper().dump(harness.request({ content: 'data' }));
    expect(harness.sink.text).toContain(
      'INSERT INTO "orders" ("id", "name") IDENTITY VALUES (NULL, NULL), (NULL, NULL);',
    );
    expect(harness.session.executed).toContain('SELECT "id", "name" FROM "orders"');
    expect(harness.sink.text).not.toContain('CREATE TABLE');
    expect(harness.sink.text).not.toContain('DROP');
    expect(harness.sink.text).not.toContain('CREATE VIEW');
  });

  it('splits many rows into several INSERT statements', async () => {
    const harness = new Harness();
    harness.rows = Array.from({ length: INSERT_ROWS * 2 + 1 }, (_, i) => [i, 'x']);
    const report = await harness
      .dumper()
      .dump(harness.request({ content: 'data', relations: [{ name: 'orders', kind: 'table' }] }));
    expect(harness.sink.text.match(/INSERT INTO/gu)).toHaveLength(3);
    expect(report.rows).toBe(INSERT_ROWS * 2 + 1);
  });

  it('writes structure only without reading a single row', async () => {
    const harness = new Harness();
    const report = await harness.dumper().dump(harness.request({ content: 'structure' }));
    expect(harness.session.executed.some((sql) => sql.startsWith('SELECT'))).toBe(false);
    expect(harness.sink.text).not.toContain('INSERT INTO');
    expect(report.rows).toBe(0);
  });

  it('dumps only the chosen tables, with the types they use and nothing else of the scope', async () => {
    const harness = new Harness();
    await harness
      .dumper()
      .dump(harness.request({ wholeScope: false, relations: [{ name: 'items', kind: 'table' }] }));
    expect(harness.sink.text).not.toContain('CREATE FUNCTION');
    expect(harness.sink.text).not.toContain('invoice_seq');
    expect(harness.session.metadata.calls).toContain('listTypeDumps:shop/sales:items');
  });

  it('creates no DROP section when asked not to', async () => {
    const harness = new Harness();
    await harness.dumper().dump(harness.request({ dropFirst: false }));
    expect(harness.sink.text).not.toContain('DROP');
  });

  it('skips what the server will not show, and says so', async () => {
    const harness = new Harness();
    harness.session.metadata.definitions.delete('function:total');
    const getDefinition = harness.session.metadata.getDefinition.bind(harness.session.metadata);
    harness.session.metadata.getDefinition = (object) =>
      object.name === 'total'
        ? Promise.reject(new DbError('permission-denied', 'hidden from you'))
        : getDefinition(object);
    const report = await harness.dumper().dump(harness.request());
    expect(report.skipped).toEqual([
      { kind: 'function', name: 'total', reason: 'hidden from you' },
    ]);
    expect(harness.sink.text).toContain('-- Skipped function total: hidden from you');
    expect(report.objects).toBe(2);
  });

  it('fails on any other error, still ending the snapshot and releasing', async () => {
    const harness = new Harness();
    harness.session.metadata.tableDumps.delete('orders');
    await expect(harness.dumper().dump(harness.request())).rejects.toMatchObject({
      code: 'not-found',
    });
    expect(harness.session.executed.at(-1)).toBe('END SNAPSHOT');
    expect(harness.released).toHaveLength(1);
  });

  it('stops with a cancelled error once aborted, cancelling the running query', async () => {
    const harness = new Harness();
    const abort = new AbortController();
    harness.rows = Array.from({ length: 500 }, (_, i) => [i, 'x']);
    const dumped = harness.dumper().dump(
      harness.request({
        signal: abort.signal,
        onProgress: () => {
          abort.abort();
        },
      }),
    );
    await expect(dumped).rejects.toMatchObject({ code: 'cancelled' });
    expect(harness.session.cancelCount).toBe(1);
    expect(harness.released).toHaveLength(1);
  });

  it('leaves the Views section out when the server hides every view, and lists them', async () => {
    const harness = new Harness();
    harness.session.metadata.getDefinition = (object) =>
      object.kind === 'view'
        ? Promise.reject(new DbError('permission-denied', 'no rights'))
        : Promise.resolve(
            harness.session.metadata.definitions.get(`${object.kind}:${object.name}`) ?? [],
          );
    const report = await harness.dumper().dump(harness.request());
    expect(harness.sink.text).not.toContain('-- Views');
    expect(report.skipped.map((item) => item.name).sort()).toEqual(['base', 'top']);
    expect(report.views).toBe(2);
  });

  it('asks for a materialized view as one', async () => {
    const harness = new Harness();
    const asked: unknown[] = [];
    const getDefinition = harness.session.metadata.getDefinition.bind(harness.session.metadata);
    harness.session.metadata.getDefinition = (object) => {
      asked.push(object);
      return getDefinition(object);
    };
    await harness.dumper().dump(
      harness.request({
        relations: [
          { name: 'orders', kind: 'table' },
          { name: 'top', kind: 'view', materialized: true },
          { name: 'base', kind: 'view' },
        ],
      }),
    );
    expect(asked).toContainEqual(expect.objectContaining({ name: 'top', materialized: true }));
    expect(asked).toContainEqual(expect.not.objectContaining({ name: 'base', materialized: true }));
  });

  it('writes no rows for a table whose every column is computed', async () => {
    const harness = new Harness();
    harness.session.metadata.structure = {
      ...STRUCTURE,
      columns: STRUCTURE.columns.map((column) => ({ ...column, generated: true })),
    };
    const report = await harness.dumper().dump(harness.request({ content: 'data' }));
    expect(harness.sink.text).not.toContain('INSERT');
    expect(harness.sink.text).not.toContain('-- Rows of orders');
    expect(report.rows).toBe(0);
  });

  it('resets a sequence that fills a column through nextval()', async () => {
    const harness = new Harness();
    harness.session.metadata.structure = {
      ...STRUCTURE,
      columns: [
        {
          name: 'id',
          dataType: 'int',
          nullable: false,
          autoIncrement: false,
          generated: false,
          defaultExpression: "nextval('orders_id_seq'::regclass)",
        },
        { name: 'name', dataType: 'text', nullable: true, autoIncrement: false, generated: false },
      ],
    };
    harness.driver.dialect = {
      ...harness.driver.dialect,
      dump: {
        ...harness.driver.dialect.dump,
        resetSequence: (table, column) => `RESET ${table.schema ?? ''}.${table.name}.${column}`,
      },
    };
    await harness.dumper().dump(harness.request({ content: 'data' }));
    expect(harness.sink.text).toContain('RESET sales.orders.id');
    expect(harness.sink.text).not.toContain('RESET sales.orders.name');
  });

  it('fails when reading a definition fails for a reason other than rights', async () => {
    const harness = new Harness();
    harness.session.metadata.getDefinition = () =>
      Promise.reject(new DbError('connection-failed', 'server went away'));
    await expect(harness.dumper().dump(harness.request())).rejects.toMatchObject({
      code: 'connection-failed',
    });
    expect(harness.session.executed.at(-1)).toBe('END SNAPSHOT');
    expect(harness.released).toHaveLength(1);
  });

  it('logs a failed cancel and still stops as cancelled', async () => {
    const harness = new Harness();
    const logger = new RecordingLogger();
    const abort = new AbortController();
    harness.rows = Array.from({ length: 500 }, (_, i) => [i, 'x']);
    harness.session.cancel = () => Promise.reject(new Error('cancel refused'));
    const dumper = new SqlDumper({
      manager: {
        driverOf: () => Promise.resolve(harness.driver as Driver),
        acquire: () => Promise.resolve(harness.session as Session),
        release: () => Promise.resolve(),
      },
      logger,
    });
    const dumped = dumper.dump(
      harness.request({
        signal: abort.signal,
        onProgress: () => {
          abort.abort();
        },
      }),
    );
    await expect(dumped).rejects.toMatchObject({ code: 'cancelled' });
    await Promise.resolve();
    expect(
      logger.entries.some((entry) => entry.message.includes('Cancelling the dump query failed')),
    ).toBe(true);
  });

  it('dumps a database without schemas under bare table names', async () => {
    const harness = new Harness();
    await harness.dumper().dump(
      harness.request({
        scope: { database: 'shop' },
        target: { connectionId: 'c', database: 'shop' },
      }),
    );
    expect(harness.sink.text).not.toContain('CREATE SCHEMA');
    expect(harness.sink.text).toContain('INSERT INTO "orders"');
  });

  it('reports progress per table and row', async () => {
    const harness = new Harness();
    const seen: unknown[] = [];
    await harness.dumper().dump(
      harness.request({
        relations: [
          { name: 'orders', kind: 'table' },
          { name: 'items', kind: 'table' },
        ],
        onProgress: (progress) => seen.push(progress),
      }),
    );
    expect(seen).toEqual([
      { table: 'orders', rows: 2, tablesDone: 0, tablesTotal: 2 },
      { table: 'items', rows: 4, tablesDone: 1, tablesTotal: 2 },
    ]);
  });

  it('names the source, contents and time at the top', async () => {
    const harness = new Harness();
    await harness.dumper().dump(harness.request({ content: 'structure' }));
    expect(
      harness.sink.text.startsWith('-- DataNest dump\n-- Source: Local / shop (postgres)\n'),
    ).toBe(true);
    expect(harness.sink.text).toContain('-- Made: 2026-10-29T10:00:00.000Z');
    expect(harness.sink.text).toContain('-- Contents: structure only');
  });
});
