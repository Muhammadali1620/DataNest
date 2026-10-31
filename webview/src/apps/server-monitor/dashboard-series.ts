// What the Manager's Dashboard charts (V11.14): which counters of a server make the
// "Traffic" and "Queries" lines, and the rolling history of their rates. The counters
// are the ones the monitor already reads; the host turns each into a change per second.

import type { MonitorStatusRow } from '../../../../src/shared/protocols/server-monitor';

export interface SeriesDef {
  readonly key: string;
  /** English label; the page translates it by `monitor.series.<key>`. */
  readonly label: string;
  /** The status counter whose change per second is the series. */
  readonly counter: string;
  /** A counter in blocks or other units becomes bytes or a plain count by this factor. */
  readonly factor?: number;
  /** A theme chart colour. */
  readonly color: string;
}

export interface SeriesSet {
  readonly unit: 'bytes' | 'count';
  readonly series: readonly SeriesDef[];
}

export interface DashboardSeries {
  readonly traffic: SeriesSet;
  readonly queries: SeriesSet;
}

const GREEN = 'var(--vscode-charts-green, var(--dn-success))';
const BLUE = 'var(--vscode-charts-blue, var(--dn-info))';
const YELLOW = 'var(--vscode-charts-yellow, var(--dn-warning))';
const PURPLE = 'var(--vscode-charts-purple, var(--dn-accent))';
const RED = 'var(--vscode-charts-red, var(--dn-danger))';

/** PostgreSQL counts blocks of 8 KB. */
const PG_BLOCK = 8192;

const POSTGRES: DashboardSeries = {
  traffic: {
    unit: 'bytes',
    series: [
      { key: 'read', label: 'read', counter: 'blks_read', factor: PG_BLOCK, color: GREEN },
      { key: 'hit', label: 'hit', counter: 'blks_hit', factor: PG_BLOCK, color: BLUE },
    ],
  },
  queries: {
    unit: 'count',
    series: [
      { key: 'insert', label: 'insert', counter: 'tup_inserted', color: GREEN },
      { key: 'update', label: 'update', counter: 'tup_updated', color: BLUE },
      { key: 'delete', label: 'delete', counter: 'tup_deleted', color: YELLOW },
      { key: 'select', label: 'select', counter: 'tup_returned', color: PURPLE },
      { key: 'fetched', label: 'fetched', counter: 'tup_fetched', color: RED },
    ],
  },
};

const MYSQL: DashboardSeries = {
  traffic: {
    unit: 'bytes',
    series: [
      { key: 'received', label: 'received', counter: 'Bytes_received', color: GREEN },
      { key: 'sent', label: 'sent', counter: 'Bytes_sent', color: BLUE },
    ],
  },
  queries: {
    unit: 'count',
    series: [
      { key: 'insert', label: 'insert', counter: 'Com_insert', color: GREEN },
      { key: 'update', label: 'update', counter: 'Com_update', color: BLUE },
      { key: 'delete', label: 'delete', counter: 'Com_delete', color: YELLOW },
      { key: 'select', label: 'select', counter: 'Com_select', color: PURPLE },
      { key: 'fetched', label: 'fetched', counter: 'Innodb_rows_read', color: RED },
    ],
  },
};

/**
 * The charts a server's status rows can draw, found by the counters they hold (so
 * MariaDB and TiDB follow MySQL, YugabyteDB and CockroachDB follow what they report);
 * undefined for a server whose counters are not known to us.
 */
export function dashboardSeries(rows: readonly MonitorStatusRow[]): DashboardSeries | undefined {
  const names = new Set(rows.map((row) => row.name));
  if (names.has('tup_inserted') && names.has('blks_read')) {
    return POSTGRES;
  }
  if (names.has('Com_select') && names.has('Bytes_received')) {
    return MYSQL;
  }
  return undefined;
}

/**
 * One reading of every series of a set: the change per second of its counter times the
 * factor. Undefined before the host has two readings to subtract (no row has a rate).
 */
export function sampleSet(
  rows: readonly MonitorStatusRow[],
  set: SeriesSet,
): Record<string, number> | undefined {
  if (!rows.some((row) => row.perSecond !== undefined)) {
    return undefined;
  }
  const rates = new Map(rows.map((row) => [row.name, row.perSecond]));
  const sample: Record<string, number> = {};
  for (const def of set.series) {
    const rate = rates.get(def.counter);
    // A counter that did not change has no rate: it is a flat zero on the chart.
    sample[def.key] = Math.max(0, (rate ?? 0) * (def.factor ?? 1));
  }
  return sample;
}

/** What the charts remember: five minutes at one reading every few seconds. */
export const HISTORY_WINDOW_MS = 5 * 60 * 1000;

export interface History {
  readonly times: readonly number[];
  readonly values: Readonly<Record<string, readonly number[]>>;
}

export const EMPTY_HISTORY: History = { times: [], values: {} };

/** The history with a reading at `at` added and everything older than the window dropped. */
export function pushSample(
  history: History,
  at: number,
  sample: Readonly<Record<string, number>>,
  windowMs = HISTORY_WINDOW_MS,
): History {
  // A reading that is not newer (the same one twice) changes nothing.
  const last = history.times.at(-1);
  if (last !== undefined && at <= last) {
    return history;
  }
  const keys = new Set([...Object.keys(history.values), ...Object.keys(sample)]);
  const times = [...history.times, at];
  let from = 0;
  while (from < times.length - 1 && (times[from] ?? 0) < at - windowMs) {
    from += 1;
  }
  const values: Record<string, number[]> = {};
  for (const key of keys) {
    const before = history.values[key] ?? [];
    // A series that joins late is zero for the times it missed.
    const padded = [
      ...Array.from({ length: history.times.length - before.length }, () => 0),
      ...before,
    ];
    values[key] = [...padded, sample[key] ?? 0].slice(from);
  }
  return { times: times.slice(from), values };
}
