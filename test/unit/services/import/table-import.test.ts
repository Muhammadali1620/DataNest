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

  it('speaks the transaction words of the dialect (SQL Server, V6.2)', async () => {
    const harness = new Harness();
    harness.driver.dialect = {
      ...harness.driver.dialect,
      transaction: {
        ...harness.driver.dialect.transaction,
        begin: 'BEGIN TRANSACTION',
        commit: 'COMMIT TRANSACTION',
        rollback: 'ROLLBACK TRANSACTION',
      },
    };
    await harness.importer().run(harness.request(rows(1)));
    expect(harness.session.executed[0]).toBe('BEGIN TRANSACTION');
    expect(harness.session.executed[2]).toBe('COMMIT TRANSACTION');
    const failing = new Harness();
    failing.driver.dialect = harness.driver.dialect;
    failing.session.failExecuteWhen = (sql) => sql.startsWith('INSERT');
    await failing.importer().run(failing.request(rows(1)));
    expect(failing.session.executed.at(-1)).toBe('ROLLBACK TRANSACTION');
  });

  describe('without transactions (ClickHouse, V6.3)', () => {
    function plain(): Harness {
      const harness = new Harness();
      harness.driver.capabilities = { ...harness.driver.capabilities, transactions: false };
      return harness;
    }

    it('imports with no transaction words at all', async () => {
      const harness = plain();
      const report = await harness.importer().run(harness.request(rows(3)));
      expect(harness.session.executed).toEqual([
        `INSERT INTO "people" ("id", "name") IDENTITY VALUES (1, 'n1'), (2, 'n2'), (3, 'n3')`,
        'RESET people.id',
      ]);
      expect(report).toMatchObject({ outcome: 'done', inserted: 3, rolledBack: false });
    });

    it('stops at the first bad row in all-or-nothing mode, rolling nothing back', async () => {
      const harness = plain();
      const records = [...rows(2), { line: 3, values: ['x', 'bad'] }, ...rows(2, 4)];
      const report = await harness.importer().run(harness.request(records));
      expect(harness.session.executed).toEqual([]);
      expect(report).toMatchObject({ outcome: 'stopped', inserted: 0, rolledBack: false, read: 3 });
    });

    it('keeps the batches that went in before the bad row', async () => {
      const harness = plain();
      const good = rows(INSERT_ROWS);
      const records = [...good, { line: INSERT_ROWS + 1, values: ['x', 'bad'] }];
      const report = await harness.importer().run(harness.request(records));
      expect(harness.inserts).toHaveLength(1);
      expect(harness.session.executed).not.toContain('BEGIN');
      expect(harness.session.executed).not.toContain('ROLLBACK');
      expect(report).toMatchObject({
        outcome: 'stopped',
        inserted: INSERT_ROWS,
        rolledBack: false,
      });
    });

    it('stops when the server refuses a batch, without a ROLLBACK', async () => {
      const harness = plain();
      harness.session.failExecuteWhen = (sql) => sql.startsWith('INSERT');
      const report = await harness.importer().run(harness.request(rows(3)));
      expect(harness.session.executed.some((sql) => /^(BEGIN|COMMIT|ROLLBACK)/u.test(sql))).toBe(
        false,
      );
      expect(report).toMatchObject({ outcome: 'stopped', inserted: 0, rolledBack: false });
    });
  });

  describe('when things go wrong midway (V9.5)', () => {
    it('stops reading the file once a full batch is refused in all-or-nothing mode', async () => {
      const harness = new Harness();
      harness.session.failExecuteWhen = (sql) => sql.startsWith('INSERT');
      const report = await harness.importer().run(harness.request(rows(INSERT_ROWS * 3)));
      expect(harness.inserts).toHaveLength(1);
      expect(harness.session.executed.at(-1)).toBe('ROLLBACK');
      expect(report).toMatchObject({ outcome: 'stopped', inserted: 0, read: INSERT_ROWS });
    });

    it('rolls back and passes on an error of the file itself', async () => {
      const harness = new Harness();
      async function* broken(): AsyncGenerator<SourceRecord> {
        await Promise.resolve();
        yield { line: 1, values: ['1', 'a'] };
        throw new DbError('syntax', 'The file ends inside a record');
      }
      await expect(
        harness.importer().run(harness.request([], { records: broken() })),
      ).rejects.toMatchObject({ code: 'syntax', message: 'The file ends inside a record' });
      expect(harness.session.executed).toEqual(['BEGIN', 'ROLLBACK']);
      expect(harness.released).toHaveLength(1);
    });

    it('calls it cancelled when the file fails after the import was stopped', async () => {
      const harness = new Harness();
      const abort = new AbortController();
      async function* stopping(): AsyncGenerator<SourceRecord> {
        await Promise.resolve();
        abort.abort();
        if (abort.signal.aborted) {
          throw new Error('read interrupted');
        }
        yield { line: 1, values: ['1', 'a'] };
      }
      await expect(
        harness.importer().run(harness.request([], { records: stopping(), signal: abort.signal })),
      ).rejects.toMatchObject({ code: 'cancelled' });
    });

    it('logs a cancel the server refuses and still stops', async () => {
      const harness = new Harness();
      const abort = new AbortController();
      harness.session.cancel = () => Promise.reject(new Error('cancel refused'));
      const report = await harness.importer().run(
        harness.request(rows(INSERT_ROWS * 2), {
          signal: abort.signal,
          onProgress: () => {
            abort.abort();
          },
        }),
      );
      expect(report.outcome).toBe('cancelled');
    });

    it('fails a row whose value the dialect cannot write, and keeps the others in skip mode', async () => {
      const harness = new Harness();
      const dialect = harness.driver.dialect;
      harness.driver.dialect = {
        ...dialect,
        literal: (value) => {
          if (value === 'too big') {
            throw new Error('Oracle takes a binary value of at most 32767 bytes');
          }
          return dialect.literal(value);
        },
      };
      const records = [
        { line: 1, values: ['1', 'a'] },
        { line: 2, values: ['2', 'too big'] },
        { line: 3, values: ['3', 'c'] },
      ];
      const report = await harness.importer().run(harness.request(records, { mode: 'skip' }));
      expect(report.inserted).toBe(2);
      expect(report.failures).toEqual([
        { line: 2, column: 'name', message: 'Oracle takes a binary value of at most 32767 bytes' },
      ]);
    });

    it('stops in skip mode when a single row loses the link', async () => {
      const harness = new Harness();
      // The batch is refused, so the rows go one by one; the second finds the server gone.
      harness.session.failExecuteWhen = (sql) => sql.includes('), (');
      const execute = harness.session.execute.bind(harness.session);
      harness.session.execute = (sql, options) => {
        if (sql.startsWith('INSERT') && !sql.includes('), (') && sql.includes("'n2'")) {
          harness.session.executeError = new DbError(
            'connection-failed',
            'server closed the connection',
          );
        }
        return execute(sql, options);
      };
      const report = await harness.importer().run(harness.request(rows(3), { mode: 'skip' }));
      expect(report).toMatchObject({ outcome: 'stopped', inserted: 1 });
      expect(report.failures.at(-1)).toMatchObject({
        line: 2,
        message: 'server closed the connection',
      });
      expect(harness.inserts.some((sql) => sql.includes("'n3'") && !sql.includes('), ('))).toBe(
        false,
      );
    });

    it('leaves sequences alone for a dialect that has nothing to move them with', async () => {
      const harness = new Harness();
      const { resetSequence: _unused, ...dump } = harness.driver.dialect.dump;
      harness.driver.dialect = { ...harness.driver.dialect, dump };
      const report = await harness.importer().run(harness.request(rows(2)));
      expect(harness.session.executed).not.toContain('RESET people.id');
      expect(report.outcome).toBe('done');
    });

    it('reports a sequence it could not move, keeping the rows', async () => {
      const harness = new Harness();
      harness.session.failExecuteWhen = (sql) => sql.startsWith('RESET');
      const report = await harness.importer().run(harness.request(rows(2)));
      expect(report).toMatchObject({ outcome: 'done', inserted: 2 });
      expect(report.failures).toEqual([
        { line: 0, column: 'id', message: 'Not allowed: RESET people.id' },
      ]);
    });
  });
});
