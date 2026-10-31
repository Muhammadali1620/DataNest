import { describe, expect, it } from 'vitest';
import type { ManagerLogEntry } from '../../../../../src/shared/protocols/manager';
import {
  canRun,
  filterRelations,
  setTicked,
} from '../../../../../webview/src/apps/manager/dump-view';
import {
  filterLog,
  formatTook,
  logOutcome,
  logText,
  logTime,
} from '../../../../../webview/src/apps/manager/log-view';
import { SECTION_LOOK, sectionAfterKey } from '../../../../../webview/src/apps/manager/sections';
import { MANAGER_SECTIONS } from '../../../../../src/shared/protocols/manager';
import { en } from '../../../../../webview/src/l10n/en';
import { ru } from '../../../../../webview/src/l10n/ru';

function line(extra: Partial<ManagerLogEntry> = {}): ManagerLogEntry {
  return { id: '1', at: 0, sql: 'SELECT 1', ok: true, durationMs: 5, runs: 1, ...extra };
}

describe('filterLog', () => {
  const entries = [
    line({ id: '1', sql: 'SELECT * FROM users' }),
    line({ id: '2', sql: 'DELETE FROM orders', ok: false, error: 'Permission denied' }),
    line({ id: '3', sql: 'select 1' }),
  ];

  it('keeps everything for an empty filter', () => {
    expect(filterLog(entries, '', false)).toHaveLength(3);
    expect(filterLog(entries, '   ', false)).toHaveLength(3);
  });

  it('wants every word, in any case, anywhere in the statement', () => {
    expect(filterLog(entries, 'FROM ORDERS', false).map((l) => l.id)).toEqual(['2']);
    expect(filterLog(entries, 'select', false).map((l) => l.id)).toEqual(['1', '3']);
  });

  it('searches the error text too', () => {
    expect(filterLog(entries, 'denied', false).map((l) => l.id)).toEqual(['2']);
  });

  it('can show the failures alone', () => {
    expect(filterLog(entries, '', true).map((l) => l.id)).toEqual(['2']);
    expect(filterLog(entries, 'users', true)).toEqual([]);
  });
});

describe('formatTook', () => {
  it('counts in milliseconds, seconds and minutes', () => {
    expect(formatTook(0)).toBe('0 ms');
    expect(formatTook(12.4)).toBe('12 ms');
    expect(formatTook(999)).toBe('999 ms');
    expect(formatTook(1000)).toBe('1 s');
    expect(formatTook(1449)).toBe('1.4 s');
    expect(formatTook(59_000)).toBe('59 s');
    expect(formatTook(125_000)).toBe('2 min 5 s');
    expect(formatTook(-5)).toBe('0 ms');
  });
});

describe('logOutcome', () => {
  it('tells rows retrieved, rows affected, plain completion and failure', () => {
    expect(logOutcome(line({ rows: 3 }))).toEqual({ key: 'manager.log.rows', args: [3, '5 ms'] });
    expect(logOutcome(line({ affected: 0 }))).toEqual({
      key: 'manager.log.affected',
      args: [0, '5 ms'],
    });
    expect(logOutcome(line())).toEqual({ key: 'manager.log.done', args: ['5 ms'] });
    expect(logOutcome(line({ ok: false, rows: 3 }))).toEqual({
      key: 'manager.log.failed',
      args: ['5 ms'],
    });
  });
});

describe('logTime and logText', () => {
  it('writes the local time down to the second', () => {
    expect(logTime(new Date(2026, 0, 2, 3, 4, 5).getTime())).toBe('2026-01-02 03:04:05');
  });

  it('copies one statement on a line, its result under it and an error under that', () => {
    const at = new Date(2026, 0, 2, 3, 4, 5).getTime();
    const text = logText(
      [line({ at, sql: 'SELECT\n  1' }), line({ at, sql: 'bad', ok: false, error: 'boom' })],
      (entry) => (entry.ok ? 'ok' : 'failed'),
    );
    expect(text).toBe('2026-01-02 03:04:05 SELECT 1\nok\n2026-01-02 03:04:05 bad\nfailed\nboom');
    expect(logText([], () => '')).toBe('');
  });
});

describe('dump form helpers', () => {
  const relations = [
    { name: 'Orders', kind: 'table' as const },
    { name: 'users', kind: 'table' as const },
    { name: 'v_orders', kind: 'view' as const },
  ];

  it('filters the relations by name, case ignored', () => {
    expect(filterRelations(relations, ' ORD ').map((r) => r.name)).toEqual(['Orders', 'v_orders']);
    expect(filterRelations(relations, '')).toHaveLength(3);
    expect(filterRelations(relations, 'zzz')).toEqual([]);
  });

  it('ticks and unticks a group of names without touching the others', () => {
    expect(setTicked(['a'], ['b', 'c'], true)).toEqual(['a', 'b', 'c']);
    expect(setTicked(['a', 'b'], ['b'], false)).toEqual(['a']);
    expect(setTicked(['a'], ['a'], true)).toEqual(['a']);
  });

  it('runs when something is ticked and there is a path', () => {
    expect(canRun(['a'], false, 'x.sql')).toBe(true);
    expect(canRun([], true, 'x.sql')).toBe(true);
    expect(canRun([], false, 'x.sql')).toBe(false);
    expect(canRun(['a'], false, '   ')).toBe(false);
  });
});

describe('sections', () => {
  const all = [...MANAGER_SECTIONS];

  it('moves down and up, round the ends', () => {
    expect(sectionAfterKey(all, 'log', 'ArrowDown')).toBe('dashboard');
    expect(sectionAfterKey(all, 'sync', 'ArrowDown')).toBe('log');
    expect(sectionAfterKey(all, 'log', 'ArrowUp')).toBe('sync');
  });

  it('jumps to the ends and ignores other keys', () => {
    expect(sectionAfterKey(all, 'dump', 'Home')).toBe('log');
    expect(sectionAfterKey(all, 'dump', 'End')).toBe('sync');
    expect(sectionAfterKey(all, 'dump', 'a')).toBeUndefined();
  });

  it('copes with a list that lacks the current section', () => {
    expect(sectionAfterKey(['log'], 'sync', 'ArrowDown')).toBeUndefined();
    expect(sectionAfterKey([], 'log', 'Home')).toBeUndefined();
  });

  it('gives every section an icon, a colour and a name in both languages', () => {
    for (const id of MANAGER_SECTIONS) {
      const look = SECTION_LOOK[id];
      expect(look.icon).toBeTruthy();
      expect(look.tone).toBeTruthy();
      expect(en[look.label]).toBeTruthy();
      expect(ru[look.label]).toBeTruthy();
    }
    expect(new Set(MANAGER_SECTIONS.map((id) => SECTION_LOOK[id].icon)).size).toBe(5);
  });
});
