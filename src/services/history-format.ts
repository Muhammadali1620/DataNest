// How a history entry is described in a list. Free of `vscode`, so the wording of
// times and durations is covered by unit tests.

/** The statement on one line, cut to a length a list can show. */
export function summaryLine(sql: string, maxLength = 90): string {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}

/** `45 ms`, `1.2 s`, `3 min 5 s`, `2 h 4 min`. */
export function formatDuration(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) {
    return `${value} ms`;
  }
  if (value < 10_000) {
    return `${(value / 1000).toFixed(1)} s`;
  }
  const seconds = Math.round(value / 1000);
  if (seconds < 60) {
    return `${seconds} s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes} min ${seconds % 60} s`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `14:05` for today, `2026-10-27 14:05` for any other day, in the user's own time zone. */
export function formatWhen(timestamp: number, now: number): string {
  const when = new Date(timestamp);
  const today = new Date(now);
  const time = `${pad(when.getHours())}:${pad(when.getMinutes())}`;
  const sameDay =
    when.getFullYear() === today.getFullYear() &&
    when.getMonth() === today.getMonth() &&
    when.getDate() === today.getDate();
  return sameDay
    ? time
    : `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ${time}`;
}
