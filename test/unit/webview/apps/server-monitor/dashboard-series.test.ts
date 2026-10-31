import { describe, expect, it } from 'vitest';
import type { MonitorStatusRow } from '../../../../../src/shared/protocols/server-monitor';
import {
  EMPTY_HISTORY,
  HISTORY_WINDOW_MS,
  dashboardSeries,
  pushSample,
  sampleSet,
} from '../../../../../webview/src/apps/server-monitor/dashboard-series';

const row = (name: string, perSecond?: number): MonitorStatusRow => ({
  name,
  value: '1',
  ...(perSecond === undefined ? {} : { perSecond }),
});

const PG = ['blks_read', 'blks_hit', 'tup_inserted', 'tup_updated'];

describe('dashboardSeries', () => {
  it('knows the counters of PostgreSQL and of MySQL and its relatives', () => {
    const pg = dashboardSeries(PG.map((name) => row(name)));
    expect(pg?.traffic.series.map((one) => one.key)).toEqual(['read', 'hit']);
    expect(pg?.queries.series.map((one) => one.key)).toEqual([
      'insert',
      'update',
      'delete',
      'select',
      'fetched',
    ]);
    const mysql = dashboardSeries([row('Com_select'), row('Bytes_received')]);
    expect(mysql?.traffic.series.map((one) => one.key)).toEqual(['received', 'sent']);
    expect(mysql?.queries.series.map((one) => one.counter)).toContain('Innodb_rows_read');
  });

  it('draws nothing for a server it does not know', () => {
    expect(dashboardSeries([row('Questions'), row('Uptime')])).toBeUndefined();
    expect(dashboardSeries([])).toBeUndefined();
  });

  it('colours every series with a theme chart colour', () => {
    const pg = dashboardSeries(PG.map((name) => row(name)));
    for (const one of [...(pg?.traffic.series ?? []), ...(pg?.queries.series ?? [])]) {
      expect(one.color).toMatch(/^var\(--vscode-charts-/);
    }
  });
});

describe('sampleSet', () => {
  const pg = dashboardSeries(PG.map((name) => row(name)));

  it('waits until some counter has a rate, which needs two readings', () => {
    expect(
      sampleSet(
        PG.map((name) => row(name)),
        pg?.traffic as never,
      ),
    ).toBeUndefined();
  });

  it('turns blocks into bytes and counters that stood still into zero', () => {
    const rows = [row('blks_read', 2), row('blks_hit', 10), row('tup_inserted', 4)];
    expect(sampleSet(rows, pg?.traffic as never)).toEqual({ read: 16_384, hit: 81_920 });
    expect(sampleSet(rows, pg?.queries as never)).toEqual({
      insert: 4,
      update: 0,
      delete: 0,
      select: 0,
      fetched: 0,
    });
  });

  it('never goes below zero when a counter was reset', () => {
    const rows = [row('blks_read', -5), row('blks_hit', 1)];
    expect(sampleSet(rows, pg?.traffic as never)?.read).toBe(0);
  });
});

describe('pushSample', () => {
  it('collects readings in order, series side by side', () => {
    let history = pushSample(EMPTY_HISTORY, 1000, { a: 1, b: 2 });
    history = pushSample(history, 4000, { a: 3, b: 4 });
    expect(history).toEqual({ times: [1000, 4000], values: { a: [1, 3], b: [2, 4] } });
  });

  it('ignores a reading that is not newer', () => {
    const history = pushSample(EMPTY_HISTORY, 1000, { a: 1 });
    expect(pushSample(history, 1000, { a: 9 })).toBe(history);
    expect(pushSample(history, 500, { a: 9 })).toBe(history);
  });

  it('forgets what is older than the window and keeps the series even', () => {
    let history = pushSample(EMPTY_HISTORY, 0, { a: 1 });
    history = pushSample(history, 1000, { a: 2 }, 2000);
    history = pushSample(history, 2500, { a: 3 }, 2000);
    history = pushSample(history, 4000, { a: 4 }, 2000);
    expect(history.times).toEqual([2500, 4000]);
    expect(history.values.a).toEqual([3, 4]);
  });

  it('keeps five minutes by default', () => {
    expect(HISTORY_WINDOW_MS).toBe(300_000);
    let history = EMPTY_HISTORY;
    for (let at = 0; at <= 400_000; at += 3000) {
      history = pushSample(history, at, { a: at });
    }
    expect(history.times[0]).toBeGreaterThanOrEqual(400_000 - 300_000 - 3000);
    expect(history.times.length).toBeLessThanOrEqual(101);
    expect(history.values.a).toHaveLength(history.times.length);
  });

  it('gives a series that joins late zeros for the readings it missed, and zero when it leaves', () => {
    let history = pushSample(EMPTY_HISTORY, 1000, { a: 1 });
    history = pushSample(history, 2000, { a: 2, b: 5 });
    expect(history.values.b).toEqual([0, 5]);
    history = pushSample(history, 3000, { b: 6 });
    expect(history.values.a).toEqual([1, 2, 0]);
  });
});
