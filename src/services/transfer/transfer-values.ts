// Values on their way between databases (V5.6): what one server returns is not always
// what another accepts. A moment with a zone goes to a column without one as UTC,
// 0 and 1 go into a boolean as false and true, and the other way round.

import type { CellValue } from '../../shared/cell-value';
import type { NeutralType } from './type-map';

const ZONED =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)$/u;

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** `2024-03-01 01:30:00+03` → `2024-02-28 22:30:00`; undefined when there is no zone. */
export function toUtc(text: string): string | undefined {
  const match = ZONED.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  let offset = 0;
  if (zone !== undefined && zone !== 'Z') {
    const sign = zone.startsWith('-') ? -1 : 1;
    const digits = zone.slice(1).replace(':', '');
    offset = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || '0'));
  }
  const at = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second ?? '0'),
    ) -
      offset * 60_000,
  );
  return (
    `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}${fraction ?? ''}`
  );
}

/**
 * `…+03` and `…Z` as `…+03:00`: the one spelling every server reads (SQL Server
 * refuses the short ones); undefined when there is no zone.
 */
export function withFullOffset(text: string): string | undefined {
  const match = ZONED.exec(text.trim());
  const zone = match?.[8];
  if (match === null || zone === undefined) {
    return undefined;
  }
  const sign = zone === 'Z' ? '+' : zone.slice(0, 1);
  const digits = zone === 'Z' ? '0000' : zone.slice(1).replace(':', '').padEnd(4, '0');
  const head = text
    .trim()
    .slice(0, text.trim().length - zone.length)
    .trimEnd();
  return `${head}${sign}${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

function textOf(cell: CellValue): string | undefined {
  if (typeof cell === 'string') {
    return cell;
  }
  if (
    typeof cell === 'object' &&
    cell !== null &&
    (cell.kind === 'datetime' || cell.kind === 'bigint' || cell.kind === 'decimal')
  ) {
    return cell.text;
  }
  return undefined;
}

/** The value as the target column, of the given neutral type, accepts it. */
export function transferValue(cell: CellValue, target: NeutralType): CellValue {
  if (cell === null) {
    return null;
  }
  switch (target.kind) {
    case 'boolean': {
      if (typeof cell === 'number') {
        return cell !== 0;
      }
      const text = textOf(cell)?.trim().toLowerCase();
      if (text === '1' || text === 't' || text === 'true') {
        return true;
      }
      if (text === '0' || text === 'f' || text === 'false') {
        return false;
      }
      return cell;
    }
    case 'integer':
    case 'decimal':
    case 'float':
      return typeof cell === 'boolean' ? (cell ? 1 : 0) : cell;
    case 'datetime': {
      if (target.zone) {
        const text = textOf(cell);
        const full = text === undefined ? undefined : withFullOffset(text);
        return full === undefined ? cell : { kind: 'datetime', text: full };
      }
      const text = textOf(cell);
      const utc = text === undefined ? undefined : toUtc(text);
      return utc === undefined ? cell : { kind: 'datetime', text: utc };
    }
    case 'json':
      return typeof cell === 'string' ? { kind: 'json', text: cell } : cell;
    case 'string':
    case 'text':
    case 'enum':
    case 'uuid':
      // A JSON object or a boolean into a text column: written as its text.
      if (typeof cell === 'boolean') {
        return cell ? 'true' : 'false';
      }
      return typeof cell === 'object' && cell.kind === 'json' ? cell.text : cell;
    case 'date':
    case 'time':
    case 'binary':
      return cell;
  }
}
