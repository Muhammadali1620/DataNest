// Unix time and dates for the Tools page's converter.

/**
 * A Unix time in seconds or milliseconds; 11 digits or fewer are seconds (up to year 5138),
 * longer ones milliseconds. Returns the time in milliseconds, or undefined.
 */
export function parseUnix(text: string): number | undefined {
  const clean = text.trim();
  if (!/^-?\d+(?:\.\d+)?$/u.test(clean)) {
    return undefined;
  }
  const digits = clean.replace(/^-/u, '').split('.')[0]?.length ?? 0;
  const ms = digits <= 11 ? Number(clean) * 1000 : Number(clean);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? Math.round(ms) : undefined;
}

const pad = (value: number, size = 2): string => String(value).padStart(size, '0');

/** `2026-10-31 13:53:33` in the viewer's time zone. */
export function formatLocal(ms: number): string | undefined {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

export function formatIso(ms: number): string | undefined {
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * `YYYY-MM-DD`, `YYYY-MM-DD HH:mm[:ss[.SSS]]` (local time) or a full ISO 8601 text with a
 * zone. Dates that do not exist (February 30) are refused rather than rolled over.
 */
export function parseDate(text: string): number | undefined {
  const clean = text.trim();
  const local =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/u.exec(clean);
  if (local !== null) {
    const [year, month, day, hour, minute, second] = local
      .slice(1)
      .map((part) => Number(part || 0));
    const ms = local[7] === undefined ? 0 : Number(local[7].padEnd(3, '0'));
    const date = new Date(year ?? 0, (month ?? 1) - 1, day, hour, minute, second, ms);
    const same =
      date.getFullYear() === year && date.getMonth() === (month ?? 1) - 1 && date.getDate() === day;
    return same ? date.getTime() : undefined;
  }
  if (/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/iu.test(clean)) {
    const value = Date.parse(clean);
    return Number.isNaN(value) ? undefined : value;
  }
  return undefined;
}
