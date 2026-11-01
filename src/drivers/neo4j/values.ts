// Values of the Query API (tagged, `{ "$type": "Integer", "_value": "42" }`) and the ones
// DataNest keeps in cells. Integers travel as decimal text, so nothing is rounded; a node,
// a relationship, a path, a list or a map becomes JSON text with the numbers as written.

import type { CellValue } from '../../shared/cell-value';
import { binaryValue, safeIntOrTag } from '../common/values';
import type { TypedValue } from './query-api';

type Entry = TypedValue | null | undefined;

function typeOf(value: Entry): string {
  return typeof value === 'object' && value !== null && typeof value.$type === 'string'
    ? value.$type
    : '';
}

function inner(value: Entry): unknown {
  return typeof value === 'object' && value !== null ? value._value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A float as the server writes it: `0.1`, `NaN`, `Infinity`, `-Infinity`. */
function floatOf(text: unknown): number | undefined {
  if (typeof text === 'number') {
    return text;
  }
  if (typeof text !== 'string') {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isNaN(parsed) && text !== 'NaN' ? undefined : parsed;
}

/** The JSON text of a value, with integers written in full and every key quoted. */
export function jsonText(value: Entry): string {
  switch (typeOf(value)) {
    case '':
      return 'null';
    case 'Null':
      return 'null';
    case 'Boolean':
      return inner(value) === true ? 'true' : 'false';
    case 'Integer': {
      const text = String(inner(value));
      return /^-?\d+$/u.test(text) ? text : JSON.stringify(text);
    }
    case 'Float': {
      const number = floatOf(inner(value));
      return number !== undefined && Number.isFinite(number)
        ? String(number)
        : JSON.stringify(String(inner(value)));
    }
    case 'List': {
      const items = inner(value);
      return `[${Array.isArray(items) ? items.map((item) => jsonText(item as Entry)).join(',') : ''}]`;
    }
    case 'Map':
      return mapText(inner(value));
    case 'Node': {
      const node = isRecord(inner(value)) ? (inner(value) as Record<string, unknown>) : {};
      return `{"elementId":${JSON.stringify(node._element_id ?? null)},"labels":${JSON.stringify(node._labels ?? [])},"properties":${mapText(node._properties)}}`;
    }
    case 'Relationship': {
      const rel = isRecord(inner(value)) ? (inner(value) as Record<string, unknown>) : {};
      return (
        `{"elementId":${JSON.stringify(rel._element_id ?? null)},"type":${JSON.stringify(rel._type ?? null)},` +
        `"from":${JSON.stringify(rel._start_node_element_id ?? null)},"to":${JSON.stringify(rel._end_node_element_id ?? null)},` +
        `"properties":${mapText(rel._properties)}}`
      );
    }
    case 'Path': {
      const parts = inner(value);
      return `[${Array.isArray(parts) ? parts.map((part) => jsonText(part as Entry)).join(',') : ''}]`;
    }
    default:
      // Dates, durations, points and the like read best as the text the server printed.
      return JSON.stringify(plainText(value));
  }
}

function mapText(map: unknown): string {
  if (!isRecord(map)) {
    return '{}';
  }
  return `{${Object.entries(map)
    .map(([key, item]) => `${JSON.stringify(key)}:${jsonText(item as Entry)}`)
    .join(',')}}`;
}

/** The text of a scalar the server prints itself (dates, durations, points). */
function plainText(value: Entry): string {
  const text = inner(value);
  return typeof text === 'string' ? text : JSON.stringify(text ?? null);
}

/** A cell as the server sent it; shapes this version does not know stay readable as JSON. */
export function fromTyped(value: Entry): CellValue {
  switch (typeOf(value)) {
    case '':
    case 'Null':
      return null;
    case 'Boolean':
      return inner(value) === true;
    case 'String':
      return typeof inner(value) === 'string' ? (inner(value) as string) : null;
    case 'Integer': {
      const text = String(inner(value));
      return /^-?\d+$/u.test(text) ? safeIntOrTag(text) : text;
    }
    case 'Float': {
      const number = floatOf(inner(value));
      return number ?? plainText(value);
    }
    case 'Base64': {
      const text = inner(value);
      return typeof text === 'string'
        ? binaryValue(new Uint8Array(Buffer.from(text, 'base64')))
        : null;
    }
    case 'List':
    case 'Map':
    case 'Node':
    case 'Relationship':
    case 'Path':
      return { kind: 'json', text: jsonText(value) };
    case 'Date':
    case 'Time':
    case 'LocalTime':
    case 'LocalDateTime':
    case 'OffsetDateTime':
    case 'ZonedDateTime':
    case 'DateTime':
      return { kind: 'datetime', text: plainText(value) };
    default:
      // Duration, Point and types of newer servers: the server's own spelling.
      return plainText(value);
  }
}

/** The type name a column shows for a value (`Integer` → `integer`), when it has one. */
export function typeName(value: Entry): string | undefined {
  const type = typeOf(value);
  return type === '' || type === 'Null' ? undefined : type.toLowerCase();
}
