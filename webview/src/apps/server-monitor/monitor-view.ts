// How the server monitor page (V8.5) filters, sorts and prints what the host reads.

import type {
  MonitorProcess,
  MonitorSetting,
  MonitorStatusRow,
} from '../../../../src/shared/protocols/server-monitor';

export type ProcessColumn = 'id' | 'user' | 'host' | 'database' | 'state' | 'seconds' | 'query';

export interface ProcessSort {
  readonly column: ProcessColumn;
  readonly descending: boolean;
}

/** The longest-running first: what a monitor is opened for. */
export const DEFAULT_SORT: ProcessSort = { column: 'seconds', descending: true };

/** Processes whose texts contain the filter, idle ones left out when asked. */
export function filterProcesses(
  rows: readonly MonitorProcess[],
  text: string,
  hideIdle: boolean,
): MonitorProcess[] {
  const needle = text.trim().toLowerCase();
  return rows.filter(
    (row) =>
      !(hideIdle && row.idle && !row.mine) &&
      (needle === '' ||
        [row.id, row.user, row.host, row.database, row.application, row.state, row.query].some(
          (part) => part?.toLowerCase().includes(needle) === true,
        )),
  );
}

export function sortProcesses(
  rows: readonly MonitorProcess[],
  sort: ProcessSort,
): MonitorProcess[] {
  const sign = sort.descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const order = compare(a, b, sort.column);
    // Equal rows keep a stable order by id, so the list does not shuffle on refresh.
    return order === 0 ? compareIds(a.id, b.id) : sign * order;
  });
}

/** The next sort after a click on a column: the same column flips, another starts. */
export function nextSort(current: ProcessSort, column: ProcessColumn): ProcessSort {
  return current.column === column
    ? { column, descending: !current.descending }
    : { column, descending: column === 'seconds' };
}

function compare(a: MonitorProcess, b: MonitorProcess, column: ProcessColumn): number {
  if (column === 'seconds') {
    return (a.seconds ?? -1) - (b.seconds ?? -1);
  }
  if (column === 'id') {
    return compareIds(a.id, b.id);
  }
  return (a[column] ?? '').localeCompare(b[column] ?? '', undefined, { sensitivity: 'base' });
}

/** Numbers by value (`9` before `10`), other ids as text. */
function compareIds(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

export function filterSettings(
  rows: readonly MonitorSetting[],
  text: string,
  changedOnly: boolean,
): MonitorSetting[] {
  const needle = text.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (!changedOnly || row.changed === true) &&
      (needle === '' ||
        [row.name, row.value, row.description].some(
          (part) => part?.toLowerCase().includes(needle) === true,
        )),
  );
}

export function filterStatus(
  rows: readonly MonitorStatusRow[],
  text: string,
  changingOnly: boolean,
): MonitorStatusRow[] {
  const needle = text.trim().toLowerCase();
  return rows.filter(
    (row) =>
      (!changingOnly || (row.perSecond !== undefined && row.perSecond !== 0)) &&
      (needle === '' ||
        [row.name, row.value, row.group].some(
          (part) => part?.toLowerCase().includes(needle) === true,
        )),
  );
}

export interface DurationUnits {
  /** After seconds: `s`. */
  readonly seconds: string;
  /** After days: `d`. */
  readonly days: string;
}

const ENGLISH_UNITS: DurationUnits = { seconds: 's', days: 'd' };

/** `0.4 s`, `12 s`, `3:05`, `2:04:09`, `3 d 2:04:09`: how long something has run. */
export function formatDuration(seconds: number, units: DurationUnits = ENGLISH_UNITS): string {
  if (seconds < 10) {
    return `${(Math.round(seconds * 10) / 10).toString()} ${units.seconds}`;
  }
  if (seconds < 60) {
    return `${Math.floor(seconds)} ${units.seconds}`;
  }
  const whole = Math.floor(seconds);
  const days = Math.floor(whole / 86_400);
  const hours = Math.floor((whole % 86_400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = whole % 60;
  const two = (value: number): string => value.toString().padStart(2, '0');
  const clock =
    hours > 0 || days > 0 ? `${hours}:${two(minutes)}:${two(rest)}` : `${minutes}:${two(rest)}`;
  return days > 0 ? `${days} ${units.days} ${clock}` : clock;
}

/** A change per second, short: `+12.5`, `−3`, `+0.02`. */
export function formatRate(perSecond: number): string {
  const size = Math.abs(perSecond);
  const digits = size >= 100 ? 0 : size >= 1 ? 1 : 2;
  const text = size.toFixed(digits).replace(/\.0+$/u, '');
  return `${perSecond < 0 ? '−' : '+'}${text}`;
}

/** The status rows keyed for `#each`: one name may be in several groups. */
export function statusKey(row: MonitorStatusRow): string {
  return `${row.group ?? ''}\u0000${row.name}`;
}
