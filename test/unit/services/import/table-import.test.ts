import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { Driver, Session } from '../../../../src/drivers/driver';
import type { SourceRecord } from '../../../../src/services/import/import-source';
import {
  type ImportColumn,
  type ImportRequest,
  MAX_IMPORT_FAILURES,
  TableImporter,
} from '../../../../src/services/import/table-import';
import { INSERT_ROWS } from '../../../../src/services/dump-script';
import { FakeDriver, FakeSession } from '../../../helpers/fake-driver';
import { RecordingLogger } from '../../../helpers/fakes';

const COLUMNS: ImportColumn[] = [
  { name: 'id', dataType: 'int', source: 0, autoIncrement: true, sequenced: true },
  { name: 'name', dataType: 'text', source: 1, autoIncrement: false, sequenced: false },
];

async function* recordsOf(rows: readonly SourceRecord[]): AsyncGenerator<SourceRecord> {
  for (const row of rows) {
    await Promise.resolve();
    yield row;
  }
}

function rows(count: number, from = 1): SourceRecord[] {
  return Array.from({ length: count }, (_, i) => ({
    line: from + i,
    values: [String(from + i), `n${from + i}`],
  }));
}

class Harness {
  readonly driver = new FakeDriver('postgres');
  readonly session = new FakeSession({ id: 'c', name: 'c', driver: 'postgres' });
  readonly released: string[] = [];

  constructor() {
    // Literals the way a real dialect writes them, so statements can be read.
    this.driver.dialect = {
      ...this.driver.dialect,
      literal: (value) =>
        value === null ? 'NULL' : typeof value === 'string' ? `'${value}'` : JSON.stringify(value),
    };
  }

  importer(): TableImporter {
    return new TableImporter({
      manager: {
        driverOf: () => Promise.resolve(this.driver as Driver),
        acquire: () => Promise.resolve(this.session as Session),
        release: (owner) => {
          this.released.push(owner);
          return Promise.resolve();
        },
      },
      logger: new RecordingLogger(),
      now: () => 0,
    });
  }

  request(records: SourceRecord[], overrides: Partial<ImportRequest> = {}): ImportRequest {
    return {
      target: { connectionId: 'c' },
      table: { schema: 's', name: 'people' },
      columns: COLUMNS,
      records: recordsOf(records),
      values: { emptyIsNull: true, nullText: '' },
      mode: 'all',
      ...overrides,
    };
  }

  get inserts(): string[] {
    return this.session.executed.filter((sql) => sql.startsWith('INSERT'));
  }
}

describe('TableImporter', () => {
  it('inserts everything in one transaction and moves the sequence', async () => {
    const harness = new Harness();
    const report = await harness.importer().run(harness.request(rows(3)));
    expect(harness.session.executed).toEqual([
      'BEGIN',
      `INSERT INTO "people" ("id", "name") IDENTITY VALUES (1, 'n1'), (2, 'n2'), (3, 'n3')`,
      'COMMIT',
      'RESET people.id',
    ]);
    expect(report).toMatchObject({
      outcome: 'done',
      read: 3,
      inserted: 3,
      failedCount: 0,
      rolledBack: false,
    });
    expect(harness.released).toHaveLength(1);
    expect(harness.released[0]).toMatch(/^task:import-/u);
  });

  it('writes large files in several INSERT statements', async () => {
    const harness = new Harness();
    await harness.importer().run(harness.request(rows(INSERT_ROWS * 2 + 3)));
    expect(harness.inserts).toHaveLength(3);
  });

  it('stops at a value that does not fit and keeps nothing in all-or-nothing mode', async () => {
    const harness = new Harness();
    const records = [...rows(2), { line: 3, values: ['x', 'bad'] }, ...rows(2, 4)];
    const report = await harness.importer().run(harness.request(records));
    expect(harness.session.executed.at(-1)).toBe('ROLLBACK');
    expect(harness.inserts).toEqual([]);
    expect(report).toMatchObject({ outcome: 'stopped', inserted: 0, rolledBack: true, read: 3 });
    expect(report.failures).toEqual([{ line: 3, column: 'id', problem: 'invalid-integer' }]);
  });

  it('rolls back when the server refuses a batch, naming its lines', async () => {
    const harness = new Harness();
    harness.session.failExecuteWhen = (sql) => sql.startsWith('INSERT');
    const report = await harness.importer().run(harness.request(rows(3, 10)));
    expect(harness.session.executed.at(-1)).toBe('ROLLBACK');
    expect(report.failures).toEqual([
      { line: 10, lastLine: 12, message: expect.stringContaining('Not allowed') as string },
    ]);
    expect(report.rolledBack).toBe(true);
  });

  it('skips bad rows and keeps the rest in skip mode', async () => {
    const harness = new Harness();
    harness.session.failExecuteWhen = (sql) => sql.includes("'n2'");
    const records = [...rows(3), { line: 4, values: ['x'] }, { line: 5, error: 'broken' }];
    const report = await harness.importer().run(harness.request(records, { mode: 'skip' }));
    expect(harness.session.executed).not.toContain('BEGIN');
    expect(harness.inserts).toEqual([
      `INSERT INTO "people" ("id", "name") IDENTITY VALUES (1, 'n1'), (2, 'n2'), (3, 'n3')`,
      `INSERT INTO "people" ("id", "name") IDENTITY VALUES (1, 'n1')`,
      `INSERT INTO "people" ("id", "name") IDENTITY VALUES (2, 'n2')`,
      `INSERT INTO "people" ("id", "name") IDENTITY VALUES (3, 'n3')`,
    ]);
    expect(report).toMatchObject({ outcome: 'done', inserted: 2, failedCount: 3, read: 5 });
    expect(report.failures.map((failure) => failure.line)).toEqual([4, 5, 2]);
  });

  it('keeps only the first failures but counts them all', async () => {
    const harness = new Harness();
    const bad = Array.from({ length: MAX_IMPORT_FAILURES + 3 }, (_, i) => ({
      line: i + 1,
      values: ['x', 'y'],
    }));
    const report = await harness.importer().run(harness.request(bad, { mode: 'skip' }));
    expect(report.failedCount).toBe(MAX_IMPORT_FAILURES + 3);
    expect(report.failures).toHaveLength(MAX_IMPORT_FAILURES);
    expect(harness.session.executed).not.toContain('RESET people.id');
  });

  it('stops when the link is lost, even in skip mode', async () => {
    const harness = new Harness();
    harness.session.executeError = new DbError('connection-failed', 'gone');
    const report = await harness.importer().run(harness.request(rows(2), { mode: 'skip' }));
    expect(report.outcome).toBe('stopped');
    expect(harness.released).toHaveLength(1);
  });

  it('is cancelled by its signal, rolling back in all-or-nothing mode', async () => {
    const harness = new Harness();
    const abort = new AbortController();
    const report = await harness.importer().run(
      harness.request(rows(INSERT_ROWS * 3), {
        signal: abort.signal,
        onProgress: (progress) => {
          if (progress.read === 5) {
            abort.abort();
          }
        },
      }),
    );
    expect(report.outcome).toBe('cancelled');
    expect(report.rolledBack).toBe(true);
    expect(harness.session.cancelCount).toBe(1);
  });

  it('refuses an import that fills no column', async () => {
    const harness = new Harness();
    await expect(harness.importer().run(harness.request(rows(1), { columns: [] }))).rejects.toThrow(
      /No column/u,
    );
    expect(harness.released).toEqual([]);
  });

  it('does without identity and sequences when no such column is filled', async () => {
    const harness = new Harness();
    await harness.importer().run(harness.request(rows(1), { columns: COLUMNS.slice(1) }));
    expect(harness.inserts).toEqual([`INSERT INTO "people" ("name") VALUES ('n1')`]);
    expect(harness.session.executed).not.toContain('RESET people.id');
  });
});
