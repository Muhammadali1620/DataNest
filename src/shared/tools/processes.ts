// The process list of the Tools page's task manager: parsing what the operating system's
// tools print (ps on Linux and macOS, PowerShell and tasklist on Windows), then the
// filter, sort and number formats the page shows. Pure text in, plain data out.

export interface ProcessInfo {
  readonly pid: number;
  readonly name: string;
  readonly user: string;
  /** Percent of one core, averaged over the process's life (what `ps` reports). */
  readonly cpu?: number;
  /** Processor time used so far, in milliseconds; where the system gives no percent. */
  readonly cpuMs?: number;
  readonly memoryKb?: number;
  /** Seconds since the process started. */
  readonly runtimeSec?: number;
  readonly command: string;
}

/** Seconds of an `ps` elapsed time: `[[dd-]hh:]mm:ss`. */
export function parseElapsed(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/u.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0)
  );
}

/** The program's own name out of a command line: its file name, or `[kernel thread]`. */
export function processName(command: string): string {
  const text = command.trim();
  if (text.startsWith('[')) {
    const close = text.indexOf(']');
    return close > 0 ? text.slice(0, close + 1) : text;
  }
  const first = text.startsWith('"')
    ? text.slice(1, text.indexOf('"', 1))
    : (text.split(/\s/u)[0] ?? '');
  const base = first.split(/[\\/]/u).at(-1) ?? first;
  return base === '' ? text : base;
}

const PS_LINE =
  /^\s*(\d+)\s+(\S+)\s+(\d+(?:[.,]\d+)?)\s+(\d+)\s+((?:\d+-)?(?:\d+:)?\d+:\d+)\s*(.*)$/u;

/** `ps -ww -eo pid=,user=,pcpu=,rss=,etime=,args=`; lines that are not a process are skipped. */
export function parsePs(output: string): ProcessInfo[] {
  const items: ProcessInfo[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const match = PS_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const [, pid, user, cpu, rss, elapsed, args] = match;
    const runtimeSec = parseElapsed(elapsed ?? '');
    const command = (args ?? '').trim();
    items.push({
      pid: Number(pid),
      name: processName(command === '' ? '?' : command),
      user: user ?? '',
      cpu: Number((cpu ?? '0').replace(',', '.')),
      memoryKb: Number(rss),
      ...(runtimeSec === undefined ? {} : { runtimeSec }),
      command,
    });
  }
  return items;
}

/** One line of `tasklist /FO CSV /NH /V` as its quoted cells. */
export function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] ?? '';
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += char;
    }
  }
  cells.push(cell);
  return cells;
}

/** pid → account of `tasklist /FO CSV /NH /V` (the user column is the seventh). */
export function parseTasklistUsers(output: string): Map<number, string> {
  const users = new Map<number, string>();
  for (const line of output.split(/\r?\n/u)) {
    const cells = parseCsvLine(line);
    const pid = Number(cells[1]);
    const user = cells[6]?.trim();
    if (
      cells.length >= 8 &&
      Number.isInteger(pid) &&
      user !== undefined &&
      user !== '' &&
      user !== 'N/A'
    ) {
      users.set(pid, user);
    }
  }
  return users;
}

interface CimRow {
  ProcessId?: unknown;
  Name?: unknown;
  CommandLine?: unknown;
  WorkingSetSize?: unknown;
  Start?: unknown;
  CpuMs?: unknown;
}

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/**
 * `Get-CimInstance Win32_Process | ConvertTo-Json`: an array, or one object when there is a
 * single process. `users` comes from tasklist; `now` is in milliseconds.
 */
export function parseWindowsProcesses(
  json: string,
  users: ReadonlyMap<number, string>,
  now: number,
): ProcessInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json.replace(/^\uFEFF/u, ''));
  } catch {
    return [];
  }
  const rows: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  const items: ProcessInfo[] = [];
  for (const raw of rows) {
    if (typeof raw !== 'object' || raw === null) {
      continue;
    }
    const row = raw as CimRow;
    const pid = finite(row.ProcessId);
    if (pid === undefined || typeof row.Name !== 'string') {
      continue;
    }
    const memory = finite(row.WorkingSetSize);
    const started = typeof row.Start === 'string' ? Date.parse(row.Start) : Number.NaN;
    const cpuMs = finite(row.CpuMs);
    items.push({
      pid,
      name: row.Name,
      user: users.get(pid) ?? '',
      ...(cpuMs === undefined ? {} : { cpuMs }),
      ...(memory === undefined ? {} : { memoryKb: Math.round(memory / 1024) }),
      ...(Number.isNaN(started)
        ? {}
        : { runtimeSec: Math.max(0, Math.round((now - started) / 1000)) }),
      command:
        typeof row.CommandLine === 'string' && row.CommandLine !== '' ? row.CommandLine : row.Name,
    });
  }
  return items;
}

// ---- What the page shows

export type ProcessSortKey = 'name' | 'cpu' | 'memory' | 'user' | 'pid' | 'runtime' | 'command';

export interface ProcessFilter {
  readonly query: string;
  readonly onlyUser?: string | undefined;
}

export function filterProcesses(
  items: readonly ProcessInfo[],
  filter: ProcessFilter,
): ProcessInfo[] {
  const words = filter.query
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== '');
  return items.filter((item) => {
    if (filter.onlyUser !== undefined && item.user !== filter.onlyUser) {
      return false;
    }
    if (words.length === 0) {
      return true;
    }
    const haystack = `${item.name} ${item.pid} ${item.user} ${item.command}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

const cpuOf = (item: ProcessInfo): number => item.cpu ?? (item.cpuMs ?? 0) / 1000;

export function sortProcesses(
  items: readonly ProcessInfo[],
  key: ProcessSortKey,
  descending: boolean,
): ProcessInfo[] {
  const compare = (a: ProcessInfo, b: ProcessInfo): number => {
    switch (key) {
      case 'cpu':
        return cpuOf(a) - cpuOf(b);
      case 'memory':
        return (a.memoryKb ?? 0) - (b.memoryKb ?? 0);
      case 'runtime':
        return (a.runtimeSec ?? 0) - (b.runtimeSec ?? 0);
      case 'pid':
        return a.pid - b.pid;
      case 'user':
        return a.user.localeCompare(b.user) || a.pid - b.pid;
      case 'command':
        return a.command.localeCompare(b.command) || a.pid - b.pid;
      case 'name':
        return a.name.localeCompare(b.name) || a.pid - b.pid;
    }
  };
  const sorted = [...items].sort(compare);
  return descending ? sorted.reverse() : sorted;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** `1d 02:03:04`, `02:03:04` or `03:04`. */
export function formatRuntime(seconds: number | undefined): string {
  if (seconds === undefined) {
    return '-';
  }
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = Math.floor(seconds % 60);
  if (days > 0) {
    return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(rest)}`;
  }
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

export function formatMemory(kb: number | undefined): string {
  if (kb === undefined) {
    return '-';
  }
  if (kb < 1024) {
    return `${kb} KB`;
  }
  const mb = kb / 1024;
  return mb < 1024 ? `${mb.toFixed(1)} MB` : `${(mb / 1024).toFixed(2)} GB`;
}

export function formatCpu(item: ProcessInfo): string {
  if (item.cpu !== undefined) {
    return `${item.cpu.toFixed(1)}%`;
  }
  return item.cpuMs === undefined ? '-' : formatRuntime(Math.round(item.cpuMs / 1000));
}
