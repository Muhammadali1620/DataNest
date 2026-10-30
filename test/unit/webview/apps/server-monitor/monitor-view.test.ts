import { describe, expect, it } from 'vitest';
import type { MonitorProcess } from '../../../../../src/shared/protocols/server-monitor';
import {
  DEFAULT_SORT,
  filterProcesses,
  filterSettings,
  filterStatus,
  formatDuration,
  formatRate,
  nextSort,
  sortProcesses,
  statusKey,
} from '../../../../../webview/src/apps/server-monitor/monitor-view';

const row = (id: string, parts: Partial<MonitorProcess> = {}): MonitorProcess => ({
  id,
  idle: false,
  mine: false,
  ...parts,
});

const ROWS = [
  row('9', { user: 'app', seconds: 5, query: 'SELECT * FROM orders' }),
  row('10', { user: 'Batch', seconds: 120, state: 'Lock wait' }),
  row('2', { user: 'app', idle: true, seconds: 900 }),
  row('3', { user: 'me', idle: true, mine: true, seconds: 0 }),
];

describe('filterProcesses', () => {
  it('hides idle sessions but never the page’s own', () => {
    expect(filterProcesses(ROWS, '', true).map((one) => one.id)).toEqual(['9', '10', '3']);
    expect(filterProcesses(ROWS, '', false)).toHaveLength(4);
  });

  it('finds the text in any column, any case', () => {
    expect(filterProcesses(ROWS, 'ORDERS', false).map((one) => one.id)).toEqual(['9']);
    expect(filterProcesses(ROWS, ' lock ', false).map((one) => one.id)).toEqual(['10']);
    expect(filterProcesses(ROWS, '10', false).map((one) => one.id)).toEqual(['10']);
    expect(filterProcesses(ROWS, 'nothing like it', false)).toEqual([]);
  });
});

describe('sortProcesses', () => {
  it('puts the longest-running first by default', () => {
    expect(sortProcesses(ROWS, DEFAULT_SORT).map((one) => one.id)).toEqual(['2', '10', '9', '3']);
  });

  it('sorts ids as numbers and texts without case, ties by id', () => {
    expect(sortProcesses(ROWS, { column: 'id', descending: false }).map((one) => one.id)).toEqual([
      '2',
      '3',
      '9',
      '10',
    ]);
    expect(sortProcesses(ROWS, { column: 'user', descending: false }).map((one) => one.id)).toEqual(
      ['2', '9', '10', '3'],
    );
    // Rows without a value go first ascending.
    expect(sortProcesses(ROWS, { column: 'query', descending: true })[0]?.id).toBe('9');
  });

  it('flips the same column and starts another one', () => {
    expect(nextSort(DEFAULT_SORT, 'seconds')).toEqual({ column: 'seconds', descending: false });
    expect(nextSort(DEFAULT_SORT, 'user')).toEqual({ column: 'user', descending: false });
    expect(nextSort({ column: 'user', descending: false }, 'seconds')).toEqual({
      column: 'seconds',
      descending: true,
    });
  });
});

describe('settings and status filters', () => {
  it('finds settings by name, value or description, changed ones alone if asked', () => {
    const settings = [
      { name: 'work_mem', value: '4MB', description: 'Memory for sorts' },
      { name: 'max_connections', value: '200', changed: true },
    ];
    expect(filterSettings(settings, 'sorts', false).map((one) => one.name)).toEqual(['work_mem']);
    expect(filterSettings(settings, '', true).map((one) => one.name)).toEqual(['max_connections']);
    expect(filterSettings(settings, '200', false)).toHaveLength(1);
  });

  it('finds status rows, changing ones alone if asked', () => {
    const status = [
      { name: 'Questions', value: '10', perSecond: 2 },
      { name: 'Uptime', value: '5' },
      { name: 'Query', value: '1', group: 'events', perSecond: 0 },
    ];
    expect(filterStatus(status, '', true).map((one) => one.name)).toEqual(['Questions']);
    expect(filterStatus(status, 'EVENTS', false).map((one) => one.name)).toEqual(['Query']);
    expect(statusKey({ name: 'Query', value: '1', group: 'events' })).not.toBe(
      statusKey({ name: 'Query', value: '1' }),
    );
  });
});

describe('formatting', () => {
  it('prints durations short', () => {
    expect(formatDuration(0.04)).toBe('0 s');
    expect(formatDuration(3.25)).toBe('3.3 s');
    expect(formatDuration(42.9)).toBe('42 s');
    expect(formatDuration(185)).toBe('3:05');
    expect(formatDuration(7449)).toBe('2:04:09');
    expect(formatDuration(3 * 86_400 + 7449)).toBe('3 d 2:04:09');
    expect(formatDuration(86_400 + 5, { seconds: 'с', days: 'д' })).toBe('1 д 0:00:05');
    expect(formatDuration(5, { seconds: 'с', days: 'д' })).toBe('5 с');
  });

  it('prints rates with their sign', () => {
    expect(formatRate(12.5)).toBe('+12.5');
    expect(formatRate(-3)).toBe('−3');
    expect(formatRate(0.023)).toBe('+0.02');
    expect(formatRate(1234.6)).toBe('+1235');
  });
});
