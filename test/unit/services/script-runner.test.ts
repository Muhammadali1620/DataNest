import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { Driver, ExecuteEvent, Session } from '../../../src/drivers/driver';
import type { SessionTarget } from '../../../src/services/connection-manager';
import {
  MAX_REPORTED_FAILURES,
  type ScriptChunk,
  type ScriptProgress,
  ScriptRunner,
  STATEMENT_EXCERPT,
} from '../../../src/services/script-runner';
import type { DriverId } from '../../../src/shared/connection';
import { FakeDriver, FakeSession } from '../../helpers/fake-driver';
import { RecordingLogger } from '../../helpers/fakes';

const TARGET: SessionTarget = { connectionId: 'c1', database: 'shop' };

/** The script in parts of `size` characters, each counted as that many bytes. */
async function* chunksOf(sql: string, size = 1000): AsyncGenerator<ScriptChunk> {
  for (let offset = 0; offset < sql.length; offset += size) {
    await Promise.resolve();
    const text = sql.slice(offset, offset + size);
    yield { text, bytes: text.length };
  }
}

class Harness {
  readonly session = new FakeSession({ id: 'c1', name: 'c1', driver: 'mysql' });
  readonly acquired: { owner: string; target: SessionTarget }[] = [];
  readonly released: string[] = [];
  readonly logger = new RecordingLogger();
  /** Affected rows each statement reports, by its text. */
  affected = new Map<string, number>();
  clock = 1000;

  constructor(readonly driverId: DriverId = 'mysql') {
    const execute = this.session.execute.bind(this.session);
    this.session.execute = (sql: string) => this.withAffected(sql, execute(sql));
  }

  runner(): ScriptRunner {
    const driver = new FakeDriver(this.driverId) as Driver;
    return new ScriptRunner({
      manager: {
        driverOf: () => Promise.resolve(driver),
        acquire: (owner, target) => {
          this.acquired.push({ owner, target });
          return Promise.resolve(this.session as Session);
        },
        release: (owner) => {
          this.released.push(owner);
          return Promise.resolve();
        },
      },
      logger: this.logger,
      now: () => (this.clock += 250),
    });
  }

  private async *withAffected(
    sql: string,
    events: AsyncIterable<ExecuteEvent>,
  ): AsyncGenerator<ExecuteEvent> {
    for await (const event of events) {
      const rows = this.affected.get(sql);
      yield event.kind === 'done' && rows !== undefined
        ? { kind: 'done', affectedRows: rows }
        : event;
    }
  }
}

describe('ScriptRunner', () => {
  it('runs every statement in order on a session of its own, then lets it go', async () => {
    const harness = new Harness();
    const report = await harness.runner().run({
      target: TARGET,
      chunks: chunksOf('SELECT 1;\nSELECT 2;\nSELECT 3', 4),
      continueOnError: false,
    });
    expect(harness.session.executed).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    expect(harness.acquired).toHaveLength(1);
    expect(harness.acquired[0]?.owner).toMatch(/^task:script-/u);
    expect(harness.acquired[0]?.target).toEqual(TARGET);
    expect(harness.released).toEqual([harness.acquired[0]?.owner]);
    expect(report).toMatchObject({
      outcome: 'done',
      statements: 3,
      failedCount: 0,
      failures: [],
      skipped: [],
      bytes: 28,
      rolledBack: false,
      durationMs: 250,
    });
  });

  it('gives each run an owner of its own', async () => {
    const harness = new Harness();
    const runner = harness.runner();
    await runner.run({ target: TARGET, chunks: chunksOf('SELECT 1'), continueOnError: false });
    await runner.run({ target: TARGET, chunks: chunksOf('SELECT 1'), continueOnError: false });
    const [first, second] = harness.acquired.map((entry) => entry.owner);
    expect(first).not.toBe(second);
  });

  it('adds up the rows the statements affected', async () => {
    const harness = new Harness();
    harness.affected.set('DELETE FROM a', 3).set('UPDATE b SET x = 1', 4);
    const report = await harness.runner().run({
      target: TARGET,
      chunks: chunksOf('DELETE FROM a;\nUPDATE b SET x = 1;\nSELECT 1;'),
      continueOnError: false,
    });
    expect(report.affectedRows).toBe(7);
  });

  it('stops at the first failure unless told to go on', async () => {
    const harness = new Harness();
    harness.session.failExecuteWhen = (sql) => sql.includes('bad');
    const report = await harness.runner().run({
      target: TARGET,
      chunks: chunksOf('SELECT 1;\n\nSELECT bad;\nSELECT 3;'),
      continueOnError: false,
    });
    expect(harness.session.executed).toEqual(['SELECT 1', 'SELECT bad']);
    expect(report.outcome).toBe('stopped');
    expect(report.statements).toBe(2);
    expect(report.stoppedAt).toEqual({
      kind: 'error',
      line: 3,
      statement: 'SELECT bad',
      message: 'Not allowed: SELECT bad',
      code: 'permission-denied',
    });
    expect(report.failures).toEqual([report.stoppedAt]);
    expect(harness.released).toHaveLength(1);
  });

  it('goes on after failures when asked, and lists every one', async () => {
    const harness = new Harness();
    harness.session.failExecuteWhen = (sql) => sql.includes('bad');
    const report = await harness.runner().run({
      target: TARGET,
      chunks: chunksOf('SELECT bad1;\nSELECT 2;\nSELECT bad3;\nSELECT 4;'),
      continueOnError: true,
    });
    expect(harness.session.executed).toHaveLength(4);
    expect(report.outcome).toBe('done');
    expect(report.stoppedAt).toBeUndefined();
    expect(report.failedCount).toBe(2);
    expect(report.failures.map((failure) => failure.line)).toEqual([1, 3]);
  });

  it('stops even when going on, once the link is lost', async () => {
    const harness = new Harness();
    harness.session.failExecuteWhen = undefined;
    const execute = harness.session.execute.bind(harness.session);
    harness.session.execute = (sql: string) => {
      if (sql === 'SELECT 2') {
        return (async function* fail(): AsyncGenerator<ExecuteEvent> {
          await Promise.resolve();
          yield* [];
          throw new DbError('connection-failed', 'Connection lost');
        })();
      }
      return execute(sql);
    };
    const report = await harness.runner().run({
      target: TARGET,
      chunks: chunksOf('SELECT 1;\nSELECT 2;\nSELECT 3;'),
      continueOnError: true,
    });
    expect(report.outcome).toBe('stopped');
    expect(report.stoppedAt?.code).toBe('connection-failed');
    expect(harness.session.executed).not.toContain('SELECT 3');
  });

  it('keeps only the first failures, but counts them all', async () => {
    const harness = new Harness();
    harness.session.failExecuteWhen = () => true;
    const count = MAX_REPORTED_FAILURES + 5;
    const sql = Array.from({ length: count }, (_, i) => `SELECT ${i};`).join('\n');
    const report = await harness
      .runner()
      .run({ target: TARGET, chunks: chunksOf(sql, 4096), continueOnError: true });
    expect(report.failedCount).toBe(count);
    expect(report.failures).toHaveLength(MAX_REPORTED_FAILURES);
  });

  it('cuts a long statement down in the report', async () => {
    const harness = new Harness();
    harness.session.failExecuteWhen = () => true;
    const long = `SELECT '${'x'.repeat(1000)}'`;
    const report = await harness
      .runner()
      .run({ target: TARGET, chunks: chunksOf(`${long};`), continueOnError: false });
    const statement = report.stoppedAt?.statement ?? '';
    expect(statement).toHaveLength(STATEMENT_EXCERPT);
    expect(statement.endsWith('…')).toBe(true);
  });

  it('reports progress by bytes read and statements run', async () => {
    const harness = new Harness();
    harness.session.failExecuteWhen = (sql) => sql === 'SELECT 2';
    const seen: ScriptProgress[] = [];
    await harness.runner().run({
      target: TARGET,
      chunks: chunksOf('SELECT 1;\nSELECT 2;\nSELECT 3;\n', 10),
      continueOnError: true,
      onProgress: (progress) => seen.push(progress),
    });
    expect(seen.at(-1)).toEqual({ bytes: 30, statements: 3, failed: 1 });
    const bytes = seen.map((progress) => progress.bytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
  });

  it('cancels the running statement and stops when aborted', async () => {
    const harness = new Harness();
    const abort = new AbortController();
    let release: () => void = () => undefined;
    harness.session.gate = () =>
      harness.session.executed.length === 2
        ? new Promise<void>((resolve) => {
            release = resolve;
            abort.abort();
          })
        : Promise.resolve();
    const running = harness.runner().run({
      target: TARGET,
      chunks: chunksOf('SELECT 1;\nSELECT 2;\nSELECT 3;'),
      continueOnError: true,
      signal: abort.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const report = await running;
    expect(harness.session.cancelCount).toBe(1);
    expect(report.outcome).toBe('cancelled');
    expect(report.failedCount).toBe(0);
    expect(harness.session.executed).toEqual(['SELECT 1', 'SELECT 2']);
    expect(harness.released).toHaveLength(1);
  });

  it('still stops as cancelled when the server refuses the cancel', async () => {
    const harness = new Harness();
    const abort = new AbortController();
    let release: () => void = () => undefined;
    harness.session.cancel = () => Promise.reject(new Error('cancel refused'));
    harness.session.gate = () =>
      harness.session.executed.length === 1
        ? new Promise<void>((resolve) => {
            release = resolve;
            abort.abort();
          })
        : Promise.resolve();
    const running = harness.runner().run({
      target: TARGET,
      chunks: chunksOf('SELECT 1;\nSELECT 2;'),
      continueOnError: false,
      signal: abort.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const report = await running;
    expect(report.outcome).toBe('cancelled');
    expect(harness.session.executed).toEqual(['SELECT 1']);
    expect(harness.released).toHaveLength(1);
  });

  it('stops before the next statement once aborted between statements', async () => {
    const harness = new Harness();
    const abort = new AbortController();
    const report = await harness.runner().run({
      target: TARGET,
      chunks: chunksOf('SELECT 1;\nSELECT 2;\nSELECT 3;'),
      continueOnError: false,
      signal: abort.signal,
      onProgress: () => {
        abort.abort();
      },
    });
    expect(report.outcome).toBe('cancelled');
    expect(harness.session.executed).toEqual(['SELECT 1']);
  });

  it('says when the script left a transaction open that closing rolled back', async () => {
    const harness = new Harness();
    harness.session.tracksTransactions = true;
    const report = await harness.runner().run({
      target: TARGET,
      chunks: chunksOf('BEGIN;\nINSERT INTO t VALUES (1);'),
      continueOnError: false,
    });
    expect(report.rolledBack).toBe(true);
    const committed = new Harness();
    committed.session.tracksTransactions = true;
    const done = await committed
      .runner()
      .run({ target: TARGET, chunks: chunksOf('BEGIN;\nCOMMIT;'), continueOnError: false });
    expect(done.rolledBack).toBe(false);
  });

  it('releases the session when reading the file fails', async () => {
    const harness = new Harness();
    async function* broken(): AsyncGenerator<ScriptChunk> {
      await Promise.resolve();
      yield { text: 'SELECT 1;\nSELECT 2;\n', bytes: 20 };
      throw new Error('EIO: read failed');
    }
    await expect(
      harness.runner().run({ target: TARGET, chunks: broken(), continueOnError: false }),
    ).rejects.toThrow('EIO');
    expect(harness.released).toHaveLength(1);
  });

  it('does not open a session it cannot get', async () => {
    const harness = new Harness();
    const runner = new ScriptRunner({
      manager: {
        driverOf: () => Promise.resolve(new FakeDriver('mysql') as Driver),
        acquire: () => Promise.reject(new DbError('auth-failed', 'Access denied')),
        release: (owner) => {
          harness.released.push(owner);
          return Promise.resolve();
        },
      },
      logger: harness.logger,
    });
    await expect(
      runner.run({ target: TARGET, chunks: chunksOf('SELECT 1'), continueOnError: false }),
    ).rejects.toThrow('Access denied');
    expect(harness.released).toEqual([]);
  });

  describe('Oracle scripts (V6.4)', () => {
    it('skips SQL*Plus commands, which belong to the client, and runs the rest', async () => {
      const script = [
        'SET DEFINE OFF',
        'PROMPT Loading',
        'WHENEVER SQLERROR EXIT SQL.SQLCODE',
        'REM a remark',
        'SET TRANSACTION READ WRITE;',
        'BEGIN',
        '  NULL;',
        'END;',
        '/',
        'EXIT',
        '',
      ].join('\n');
      const harness = new Harness('oracle');
      const report = await harness
        .runner()
        .run({ target: TARGET, chunks: chunksOf(script, 5), continueOnError: false });
      expect(report.failures).toEqual([]);
      expect(harness.session.executed).toEqual([
        'SET TRANSACTION READ WRITE',
        'BEGIN\n  NULL;\nEND;',
      ]);
      expect(report.skipped.map((skip) => skip.line)).toEqual([1, 2, 3, 4, 10]);
    });
  });

  describe('PostgreSQL dumps', () => {
    const dump = [
      '\\restrict abc',
      'SET client_encoding = UTF8;',
      'COPY t (a) FROM stdin;',
      '1',
      '\\.',
      '\\connect other',
      'SELECT 1;',
      '',
    ].join('\n');

    it('skips harmless psql commands and reports COPY and \\connect as failures', async () => {
      const harness = new Harness('postgres');
      const report = await harness
        .runner()
        .run({ target: TARGET, chunks: chunksOf(dump, 7), continueOnError: true });
      expect(harness.session.executed).toEqual(['SET client_encoding = UTF8', 'SELECT 1']);
      expect(report.skipped).toEqual([{ line: 1, text: '\\restrict abc' }]);
      expect(report.failures).toEqual([
        { kind: 'copy-from-stdin', line: 3, statement: 'COPY t (a) FROM stdin' },
        { kind: 'psql-command', line: 6, statement: '\\connect other' },
      ]);
      expect(report.statements).toBe(2);
    });

    it('stops at COPY when not going on', async () => {
      const harness = new Harness('postgres');
      const report = await harness
        .runner()
        .run({ target: TARGET, chunks: chunksOf(dump), continueOnError: false });
      expect(report.outcome).toBe('stopped');
      expect(report.stoppedAt?.kind).toBe('copy-from-stdin');
      expect(harness.session.executed).toEqual(['SET client_encoding = UTF8']);
    });
  });
});
