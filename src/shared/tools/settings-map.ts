// The settings card of the Tools page: which of the extension's own `datanest.*` settings it
// shows, in which group, and the checks a value passes before the host writes it. The
// schema is the extension's package.json `contributes.configuration`, so a new setting
// appears here with no code; only the group of a setting is decided in this file.

/** What the page reads of one entry of `contributes.configuration`. */
export interface ConfigProperty {
  readonly type?: string | readonly string[];
  readonly default?: unknown;
  readonly enum?: readonly unknown[];
  readonly enumDescriptions?: readonly string[];
  readonly description?: string;
  readonly markdownDescription?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export const SETTING_GROUPS = [
  'general',
  'editor',
  'format',
  'sql',
  'tree',
  'result',
  'redis',
] as const;
export type SettingGroupId = (typeof SETTING_GROUPS)[number];

export type SettingValue = string | number | boolean;

export interface SettingItem {
  readonly id: string;
  readonly kind: 'boolean' | 'choice' | 'number' | 'text';
  /** The first sentence of the setting's description, in the editor's language. */
  readonly label: string;
  readonly description: string;
  readonly value: SettingValue;
  readonly default: SettingValue;
  readonly choices?: { value: string; label: string }[];
  readonly min?: number;
  readonly max?: number;
  readonly integer?: boolean;
}

export interface SettingGroup {
  readonly id: SettingGroupId;
  readonly items: SettingItem[];
}

const PREFIX = 'datanest.';

const SQL_SETTINGS = [
  'safeMode',
  'transactionMode',
  'queryVariables',
  'queryTimeout',
  'historyLimit',
];

/** The group of a setting; `undefined` keeps a setting off the page. */
export function groupOf(id: string): SettingGroupId | undefined {
  if (!id.startsWith(PREFIX)) {
    return undefined;
  }
  const rest = id.slice(PREFIX.length);
  if (rest.startsWith('editor.')) {
    return 'editor';
  }
  if (rest.startsWith('format.')) {
    return 'format';
  }
  if (rest.startsWith('redis.')) {
    return 'redis';
  }
  if (rest.startsWith('tree.') || rest === 'showSystemObjects' || rest === 'connections.sync') {
    return 'tree';
  }
  if (rest === 'rowLimit' || rest === 'pageSize') {
    return 'result';
  }
  return SQL_SETTINGS.includes(rest) ? 'sql' : 'general';
}

function kindOf(property: ConfigProperty): SettingItem['kind'] | undefined {
  const type: string | undefined =
    typeof property.type === 'string' ? property.type : property.type?.[0];
  if (property.enum?.every((value) => typeof value === 'string') === true) {
    return property.enum.length > 0 ? 'choice' : undefined;
  }
  if (type === 'boolean') {
    return 'boolean';
  }
  if (type === 'integer' || type === 'number') {
    return 'number';
  }
  return type === 'string' ? 'text' : undefined;
}

/** The first sentence, without the closing full stop. */
export function labelOf(description: string): string {
  const flat = description.replace(/\s+/gu, ' ').trim();
  // A stop ends the sentence only before a capital, a digit or an opening mark: "e.g. x" stays whole.
  const end = flat.search(/[.!?](?=\s+[\p{Lu}\p{N}"'«([]|\s*$)/u);
  return (end === -1 ? flat : flat.slice(0, end)).replace(/[.]$/u, '');
}

const isValue = (value: unknown): value is SettingValue =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** The items of every group, in the order of the groups and of package.json. */
export function buildGroups(
  properties: Readonly<Record<string, ConfigProperty>>,
  read: (id: string) => unknown,
): SettingGroup[] {
  const groups = new Map<SettingGroupId, SettingItem[]>(SETTING_GROUPS.map((id) => [id, []]));
  for (const [id, property] of Object.entries(properties)) {
    const group = groupOf(id);
    const kind = kindOf(property);
    if (group === undefined || kind === undefined) {
      continue;
    }
    const fallback: SettingValue = isValue(property.default)
      ? property.default
      : kind === 'boolean'
        ? false
        : kind === 'number'
          ? (property.minimum ?? 0)
          : '';
    const current = read(id);
    const description = property.description ?? property.markdownDescription ?? id;
    const choices =
      kind === 'choice'
        ? (property.enum ?? []).map((value) => ({ value: String(value), label: String(value) }))
        : undefined;
    groups.get(group)?.push({
      id,
      kind,
      label: labelOf(description),
      description,
      value: isValue(current) ? current : fallback,
      default: fallback,
      ...(choices === undefined ? {} : { choices }),
      ...(property.minimum === undefined ? {} : { min: property.minimum }),
      ...(property.maximum === undefined ? {} : { max: property.maximum }),
      ...(property.type === 'integer' ? { integer: true } : {}),
    });
  }
  return SETTING_GROUPS.flatMap((id) => {
    const items = groups.get(id) ?? [];
    return items.length === 0 ? [] : [{ id, items }];
  });
}

export type CheckedSetting =
  { readonly ok: true; readonly value: SettingValue } | { readonly ok: false };

/** A value the page sent, checked against the setting's own schema. */
export function checkSetting(
  properties: Readonly<Record<string, ConfigProperty>>,
  id: string,
  value: unknown,
): CheckedSetting {
  const property = properties[id];
  if (property === undefined || groupOf(id) === undefined) {
    return { ok: false };
  }
  const kind = kindOf(property);
  if (kind === 'boolean') {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false };
  }
  if (kind === 'choice') {
    return typeof value === 'string' && (property.enum ?? []).includes(value)
      ? { ok: true, value }
      : { ok: false };
  }
  if (kind === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { ok: false };
    }
    if (
      (property.type === 'integer' && !Number.isInteger(value)) ||
      (property.minimum !== undefined && value < property.minimum) ||
      (property.maximum !== undefined && value > property.maximum)
    ) {
      return { ok: false };
    }
    return { ok: true, value };
  }
  if (kind === 'text') {
    return typeof value === 'string' && value.length <= 200 ? { ok: true, value } : { ok: false };
  }
  return { ok: false };
}

/** Ids that belong to the page's groups: what "reset" may touch. */
export function knownIds(properties: Readonly<Record<string, ConfigProperty>>): string[] {
  return Object.entries(properties)
    .filter(([id, property]) => groupOf(id) !== undefined && kindOf(property) !== undefined)
    .map(([id]) => id);
}

/** A run of text of a setting's description: plain, **bold** or `code`. */
export interface InlineSpan {
  readonly text: string;
  readonly style: 'plain' | 'bold' | 'code';
}

/**
 * The inline markdown of a description as spans the page draws with its own elements, so
 * nothing is ever put into the page as HTML. Only `code` and **bold** are read; an
 * unclosed mark stays as typed.
 */
export function inlineSpans(text: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*/gu;
  let from = 0;
  for (const found of text.matchAll(pattern)) {
    if (found.index > from) {
      spans.push({ text: text.slice(from, found.index), style: 'plain' });
    }
    const code = found[1];
    spans.push(
      code === undefined ? { text: found[2] ?? '', style: 'bold' } : { text: code, style: 'code' },
    );
    from = found.index + found[0].length;
  }
  if (from < text.length) {
    spans.push({ text: text.slice(from), style: 'plain' });
  }
  return spans;
}

/** What a description says after its first sentence (the label); empty when it is one sentence. */
export function detailOf(description: string): string {
  const flat = description.replace(/\s+/gu, ' ').trim();
  const end = flat.search(/[.!?](?=\s+[\p{Lu}\p{N}"'«([]|\s*$)/u);
  return end === -1 ? '' : flat.slice(end + 1).trim();
}
