// Pure helpers of the Redis key page (V7.3): how a TTL, a size and a value are shown,
// and how what the user typed becomes a value to send. Kept apart from the components
// so they are tested directly.

import { hexBytes, type RedisValue } from '../../../../src/shared/redis-value';

/** `2d 03:04:05`, `03:04:05`, `00:00:07`: the time left, to the second. */
export function formatTtl(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(total / 86_400);
  const clock = [Math.floor((total % 86_400) / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
  return days > 0 ? `${days}d ${clock}` : clock;
}

/** `512 B`, `1.5 KB`, `20.0 MB`. */
export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit] ?? 'TB'}`;
}

/** How the value box shows a value. */
export type ValueMode = 'text' | 'json' | 'hex';

/** The text pretty printed when it is a JSON object or array; undefined otherwise. */
export function prettyJson(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed) as unknown, null, 2);
  } catch {
    // Not JSON after all: the text stays as it is.
    return undefined;
  }
}

const ENCODER = new TextEncoder();

/** The bytes of a value as hex pairs separated by spaces, 16 per line. */
export function hexOf(value: RedisValue): string {
  const hex =
    value.hex ??
    Array.from(ENCODER.encode(value.text), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const pairs = hex.match(/.{1,2}/g) ?? [];
  const lines: string[] = [];
  for (let index = 0; index < pairs.length; index += 16) {
    lines.push(pairs.slice(index, index + 16).join(' '));
  }
  return lines.join('\n');
}

/** The mode a value opens in: hex when it is not text, JSON when it looks like JSON. */
export function initialMode(value: RedisValue): ValueMode {
  if (value.hex !== undefined) {
    return 'hex';
  }
  return prettyJson(value.text) === undefined ? 'text' : 'json';
}

/** What the box shows for a value in a mode. */
export function shownText(value: RedisValue, mode: ValueMode): string {
  switch (mode) {
    case 'hex':
      return hexOf(value);
    case 'json':
      return prettyJson(value.text) ?? value.text;
    case 'text':
      return value.text;
  }
}

/**
 * The value to send for what the user typed in a mode; undefined for hex that does not
 * parse. JSON is sent as typed: re-encoding it would change numbers and spacing.
 */
export function typedValue(typed: string, mode: ValueMode): RedisValue | undefined {
  if (mode !== 'hex') {
    return { text: typed };
  }
  const bytes = hexBytes(typed);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    // Not UTF-8: the bytes go as hex.
    return {
      text: '',
      hex: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  }
}

/** One line of a value for a table cell: line breaks shown, long text cut. */
export function cellText(value: RedisValue | undefined, max = 200): string {
  if (value === undefined) {
    return '';
  }
  const flat = value.text.replace(/\r?\n/g, '↵');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Whole seconds from what the user typed for a TTL; undefined unless a positive integer. */
export function parseTtlSeconds(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) && Number(trimmed) > 0 ? Number(trimmed) : undefined;
}

/** What the item editor holds while the user types. */
export interface ItemDraft {
  field?: RedisValue | undefined;
  value?: RedisValue | undefined;
  score?: string;
  /** Where a new list element goes. */
  end?: 'head' | 'tail';
  /** The id of a new stream entry; `*` lets the server choose. */
  id?: string;
  /** Field and value pairs of a new stream entry. */
  pairs?: { field: string; value: string }[];
}

/** A request of the page protocol with its parameters. */
export type PageRequest =
  | { method: 'setField'; params: { field: RedisValue; value: RedisValue; previous?: RedisValue } }
  | { method: 'deleteField'; params: { field: RedisValue } }
  | { method: 'setListItem'; params: { index: number; expected: RedisValue; value: RedisValue } }
  | { method: 'pushListItem'; params: { end: 'head' | 'tail'; value: RedisValue } }
  | { method: 'removeListItem'; params: { index: number; expected: RedisValue } }
  | { method: 'setMember'; params: { value: RedisValue; previous?: RedisValue } }
  | { method: 'deleteMember'; params: { value: RedisValue } }
  | {
      method: 'setScoredMember';
      params: { value: RedisValue; score: string; previous?: RedisValue };
    }
  | {
      method: 'addEntry';
      params: { id: string; fields: { field: RedisValue; value: RedisValue }[] };
    }
  | { method: 'deleteEntry'; params: { id: string } };

/** An item as the page knows it; only the parts of its type are set. */
export interface PageItem {
  value?: RedisValue;
  field?: RedisValue;
  index?: number;
  score?: string;
  id?: string;
  fields?: { field: RedisValue; value: RedisValue }[];
}

function sameBytes(a: RedisValue | undefined, b: RedisValue | undefined): boolean {
  return (a?.hex ?? `t:${a?.text ?? ''}`) === (b?.hex ?? `t:${b?.text ?? ''}`);
}

/**
 * The request that saves a draft: a new item when `original` is undefined, else a
 * change of it. Undefined while the draft is incomplete (a value is missing or its hex
 * does not parse, a score is empty, a stream entry has no field).
 */
export function saveRequest(
  type: string,
  original: PageItem | undefined,
  draft: ItemDraft,
): PageRequest | undefined {
  const { value } = draft;
  switch (type) {
    case 'hash': {
      if (draft.field === undefined || value === undefined) {
        return undefined;
      }
      const renamed = original?.field !== undefined && !sameBytes(original.field, draft.field);
      return {
        method: 'setField',
        params: {
          field: draft.field,
          value,
          ...(renamed && original.field !== undefined ? { previous: original.field } : {}),
        },
      };
    }
    case 'list':
      if (value === undefined) {
        return undefined;
      }
      return original?.index === undefined || original.value === undefined
        ? { method: 'pushListItem', params: { end: draft.end ?? 'tail', value } }
        : {
            method: 'setListItem',
            params: { index: original.index, expected: original.value, value },
          };
    case 'set': {
      if (value === undefined) {
        return undefined;
      }
      const renamed = original?.value !== undefined && !sameBytes(original.value, value);
      return {
        method: 'setMember',
        params: {
          value,
          ...(renamed && original.value !== undefined ? { previous: original.value } : {}),
        },
      };
    }
    case 'zset': {
      const score = (draft.score ?? '').trim();
      if (value === undefined || score === '') {
        return undefined;
      }
      const renamed = original?.value !== undefined && !sameBytes(original.value, value);
      return {
        method: 'setScoredMember',
        params: {
          value,
          score,
          ...(renamed && original.value !== undefined ? { previous: original.value } : {}),
        },
      };
    }
    case 'stream': {
      const fields = (draft.pairs ?? [])
        .filter((pair) => pair.field !== '')
        .map((pair) => ({ field: { text: pair.field }, value: { text: pair.value } }));
      if (original !== undefined || fields.length === 0) {
        return undefined;
      }
      return { method: 'addEntry', params: { id: (draft.id ?? '*').trim() || '*', fields } };
    }
    default:
      return undefined;
  }
}

/** The request that removes an item; undefined for a type without items. */
export function deleteRequest(type: string, item: PageItem): PageRequest | undefined {
  switch (type) {
    case 'hash':
      return item.field === undefined
        ? undefined
        : { method: 'deleteField', params: { field: item.field } };
    case 'list':
      return item.index === undefined || item.value === undefined
        ? undefined
        : { method: 'removeListItem', params: { index: item.index, expected: item.value } };
    case 'set':
    case 'zset':
      return item.value === undefined
        ? undefined
        : { method: 'deleteMember', params: { value: item.value } };
    case 'stream':
      return item.id === undefined ? undefined : { method: 'deleteEntry', params: { id: item.id } };
    default:
      return undefined;
  }
}

/** A stable identity of an item in the list, for keyed blocks and selection. */
export function itemKey(item: PageItem): string {
  if (item.id !== undefined) {
    return `id:${item.id}`;
  }
  if (item.index !== undefined) {
    return `ix:${item.index}`;
  }
  const part = (value: RedisValue | undefined): string => value?.hex ?? `t:${value?.text ?? ''}`;
  return `${part(item.field)}|${part(item.value)}`;
}
