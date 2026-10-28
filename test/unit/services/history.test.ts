import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_HISTORY_LIMIT,
  HISTORY_STATE_KEY,
  type HistoryRecord,
  MAX_HISTORY_SQL_LENGTH,
  QueryHistory,
} from '../../../src/services/history';
import { FakeMemento, RecordingLogger } from '../../helpers/fakes';

describe('QueryHistory', () => {
  let state: FakeMemento;
  let logger: RecordingLogger;
  let limit: number;
  let clock: number;
  let names: Map<string, string>;
  let history: QueryHistory;

  function make(): QueryHistory {
    return new QueryHistory({
      state,
      logger,
      limit: () => limit,
      nameOf: (id) => names.get(id),
      now: () => clock,
    });
  }

  function run(sql: string, extra: Partial<HistoryRecord> = {}): void {
    clock += 1000;
    history.record({ sql, connectionId: 'c1', durationMs: 12, rows: 3, ...extra });
  }

  beforeEach(() => {
    state = new FakeMemento();
    logger = new RecordingLogger();
    limit = DEFAULT_HISTORY_LIMIT;
    clock = 1_700_000_000_000;
    names = new Map([
      ['c1', 'Local'],
      ['c2', 'Staging'],
    ]);
    history = make();
  });

  describe('recording', () => {
    it('keeps what ran, where and how it went', () => {
      run('SELECT 1', { database: 'app', durationMs: 12.6, rows: 1 });
      expect(history.list()).toMatchObject([
        {
          sql: 'SELECT 1',
          connectionId: 'c1',
          connectionName: 'Local',
          database: 'app',
          durationMs: 13,
          ok: true,
          rows: 1,
          runs: 1,
          executedAt: clock,
        },
      ]);
    });

    it('keeps a failure with its message', () => {
      run('SELEC 1', { rows: undefined, error: 'syntax error near SELEC' });
      expect(history.list()[0]).toMatchObject({ ok: false, error: 'syntax error near SELEC' });
    });

    it('keeps the rows a write reported', () => {
      run('DELETE FROM t', { rows: undefined, affected: 4 });
      expect(history.list()[0]).toMatchObject({ affected: 4 });
      expect(history.list()[0]).not.toHaveProperty('rows');
    });

    it('lists the newest first', () => {
      run('SELECT 1');
      run('SELECT 2');
      run('SELECT 3');
      expect(history.list().map((entry) => entry.sql)).toEqual([
        'SELECT 3',
        'SELECT 2',
        'SELECT 1',
      ]);
    });

    it('trims the statement and ignores a blank one', () => {
      run('  SELECT 1;  \n');
      run('   \n\t');
      run('');
      expect(history.list().map((entry) => entry.sql)).toEqual(['SELECT 1;']);
    });

    it('folds an immediate repeat into one entry with a counter', () => {
      run('SELECT 1', { rows: 1 });
      run('SELECT 1', { rows: 5 });
      run('SELECT 1', { rows: 7 });
      const [entry, ...rest] = history.list();
      expect(rest).toEqual([]);
      expect(entry).toMatchObject({ runs: 3, rows: 7, executedAt: clock });
    });

    it('keeps the outcome of the latest of the repeats', () => {
      run('SELECT 1');
      run('SELECT 1', { rows: undefined, error: 'boom' });
      expect(history.list()[0]).toMatchObject({ runs: 2, ok: false, error: 'boom' });
    });

    it('does not fold a repeat on another connection or database, or after another statement', () => {
      run('SELECT 1');
      run('SELECT 1', { connectionId: 'c2' });
      run('SELECT 1', { connectionId: 'c2', database: 'other' });
      run('SELECT 2', { connectionId: 'c2', database: 'other' });
      run('SELECT 1', { connectionId: 'c2', database: 'other' });
      expect(history.size).toBe(5);
    });

    it('does not keep a statement too long to be worth rerunning', () => {
      run(`SELECT '${'x'.repeat(MAX_HISTORY_SQL_LENGTH)}'`);
      expect(history.size).toBe(0);
    });

    it('cuts a long error message', () => {
      run('SELECT 1', { rows: undefined, error: 'e'.repeat(5000) });
      expect(history.list()[0]?.error).toHaveLength(1000);
    });

    it('falls back to the id when the connection has no name', () => {
      run('SELECT 1', { connectionId: 'gone' });
      expect(history.list()[0]?.connectionName).toBe('gone');
    });
  });

  describe('secrets', () => {
    it('masks a password in the statement and says so', () => {
      run("CREATE USER bob IDENTIFIED BY 'hunter2'");
      const [entry] = history.list();
      expect(entry?.sql).not.toContain('hunter2');
      expect(entry?.sql).toContain('***');
      expect(entry?.redacted).toBe(true);
    });

    it('does not keep a secret in what it saved either', () => {
      run("ALTER ROLE r PASSWORD 'topsecret'");
      expect(JSON.stringify(state.get(HISTORY_STATE_KEY))).not.toContain('topsecret');
    });

    it('leaves an ordinary statement alone', () => {
      run('SELECT * FROM users WHERE id = 1');
      expect(history.list()[0]?.sql).toBe('SELECT * FROM users WHERE id = 1');
      expect(history.list()[0]).not.toHaveProperty('redacted');
    });
  });

  describe('limit', () => {
    it('drops the oldest entries beyond the limit', () => {
      limit = 3;
      for (const n of [1, 2, 3, 4, 5]) {
        run(`SELECT ${n}`);
      }
      expect(history.list().map((entry) => entry.sql)).toEqual([
        'SELECT 5',
        'SELECT 4',
        'SELECT 3',
      ]);
    });

    it('records nothing at zero', () => {
      limit = 0;
      run('SELECT 1');
      expect(history.size).toBe(0);
      expect(state.get(HISTORY_STATE_KEY)).toBeUndefined();
    });

    it('applies a smaller limit at once, and empties the history at zero', () => {
      for (const n of [1, 2, 3, 4]) {
        run(`SELECT ${n}`);
      }
      limit = 2;
      history.enforceLimit();
      expect(history.size).toBe(2);
      limit = 0;
      history.enforceLimit();
      expect(history.size).toBe(0);
    });
  });

  describe('search', () => {
    beforeEach(() => {
      run('SELECT * FROM Users WHERE active = 1');
      run('SELECT name FROM orders', { connectionId: 'c2' });
      run('UPDATE users SET name = 1', { rows: undefined, error: 'denied' });
    });

    it('finds text anywhere in the statement, ignoring case', () => {
      expect(history.list({ text: 'users' })).toHaveLength(2);
      expect(history.list({ text: 'ORDERS' })).toHaveLength(1);
      expect(history.list({ text: 'where active' })).toHaveLength(1);
    });

    it('wants every word, in any order', () => {
      expect(history.list({ text: 'name users' })).toHaveLength(1);
      expect(history.list({ text: 'orders users' })).toHaveLength(0);
    });

    it('treats blank text as no search', () => {
      expect(history.list({ text: '   ' })).toHaveLength(3);
    });

    it('filters by connection and by failure, and combines them with text', () => {
      expect(history.list({ connectionId: 'c2' }).map((entry) => entry.sql)).toEqual([
        'SELECT name FROM orders',
      ]);
      expect(history.list({ onlyFailed: true }).map((entry) => entry.sql)).toEqual([
        'UPDATE users SET name = 1',
      ]);
      expect(history.list({ connectionId: 'c1', text: 'name' })).toHaveLength(1);
      expect(history.list({ connectionId: 'c2', text: 'users' })).toHaveLength(0);
    });

    it('treats a regex-looking search as plain text', () => {
      run('SELECT a.* FROM t');
      expect(history.list({ text: 'a.*' })).toHaveLength(1);
      expect(history.list({ text: '(' })).toHaveLength(0);
    });
  });

  describe('connections', () => {
    it('lists the connections that have entries with their counts, newest first', () => {
      run('SELECT 1');
      run('SELECT 2', { connectionId: 'c2' });
      run('SELECT 3', { connectionId: 'c2' });
      expect(history.connections()).toEqual([
        { id: 'c2', name: 'Staging', count: 2 },
        { id: 'c1', name: 'Local', count: 1 },
      ]);
    });

    it('shows a renamed connection by its current name, and a removed one by the old name', () => {
      run('SELECT 1');
      run('SELECT 2', { connectionId: 'c2' });
      names.set('c1', 'Renamed');
      names.delete('c2');
      expect(history.connections().map((c) => c.name)).toEqual(['Staging', 'Renamed']);
    });
  });

  describe('removing', () => {
    it('removes one entry', () => {
      run('SELECT 1');
      run('SELECT 2');
      const id = history.list()[0]?.id ?? '';
      expect(history.remove(id)).toBe(true);
      expect(history.list().map((entry) => entry.sql)).toEqual(['SELECT 1']);
      expect(history.remove(id)).toBe(false);
    });

    it('clears everything, or one connection', () => {
      run('SELECT 1');
      run('SELECT 2', { connectionId: 'c2' });
      run('SELECT 3', { connectionId: 'c2' });
      expect(history.clear('c2')).toBe(2);
      expect(history.list().map((entry) => entry.sql)).toEqual(['SELECT 1']);
      expect(history.clear()).toBe(1);
      expect(history.size).toBe(0);
      expect(history.clear()).toBe(0);
    });

    it('gives a new entry its own id after the old ones were removed', () => {
      run('SELECT 1');
      const first = history.list()[0]?.id;
      history.clear();
      run('SELECT 1');
      expect(history.list()[0]?.id).not.toBe(first);
    });
  });

  describe('persistence', () => {
    it('survives a restart', () => {
      run('SELECT 1');
      run('SELECT 2', { connectionId: 'c2', database: 'd' });
      const reopened = make();
      expect(reopened.list()).toEqual(history.list());
    });

    it('keeps ids unique after a restart', () => {
      run('SELECT 1');
      const reopened = make();
      clock += 1000;
      reopened.record({ sql: 'SELECT 2', connectionId: 'c1', durationMs: 1 });
      const ids = reopened.list().map((entry) => entry.id);
      expect(new Set(ids).size).toBe(2);
    });

    it('starts empty and says so when the saved history is damaged', () => {
      state.data.set(HISTORY_STATE_KEY, { version: 1, items: [{ nonsense: true }] });
      expect(make().size).toBe(0);
      expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
      state.data.set(HISTORY_STATE_KEY, 'garbage');
      expect(make().size).toBe(0);
    });

    it('survives a failing save', async () => {
      const failing = new QueryHistory({
        state: { get: () => undefined, update: () => Promise.reject(new Error('disk full')) },
        logger,
        limit: () => 10,
        nameOf: () => 'x',
      });
      failing.record({ sql: 'SELECT 1', connectionId: 'c1', durationMs: 1 });
      await Promise.resolve();
      await Promise.resolve();
      expect(failing.size).toBe(1);
      expect(logger.entries.some((entry) => entry.message.includes('Could not save'))).toBe(true);
    });
  });

  describe('listeners', () => {
    it('tells listeners about every change, and stops after dispose', () => {
      let calls = 0;
      const subscription = history.onDidChange(() => {
        calls += 1;
      });
      run('SELECT 1');
      history.remove(history.list()[0]?.id ?? '');
      expect(calls).toBe(2);
      subscription.dispose();
      run('SELECT 2');
      expect(calls).toBe(2);
    });

    it('is not broken by a listener that throws', () => {
      history.onDidChange(() => {
        throw new Error('bad listener');
      });
      expect(() => {
        run('SELECT 1');
      }).not.toThrow();
      expect(history.size).toBe(1);
    });
  });
});
