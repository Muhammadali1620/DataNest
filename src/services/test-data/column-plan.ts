// Which generator fits a column (V5.5): its name says the most (`email`, `city`,
// `created_at`), its type says the rest, and keys decide what must not repeat or
// must point at an existing row.

import { clickhouseBareType } from '../../shared/clickhouse-types';
import { enumOptions, inputKindOf } from '../../shared/cell-input';
import type { DriverId } from '../../shared/connection';
import type { GeneratorKind, GeneratorSettings } from './generators';

export interface PlanColumn {
  readonly name: string;
  readonly dataType: string;
  readonly nullable: boolean;
  readonly autoIncrement: boolean;
  readonly generated: boolean;
  /** No two rows may hold the same value: a one-column primary or unique key. */
  readonly unique: boolean;
  /** A one-column foreign key: values come from this table's column. */
  readonly reference?: { readonly table: string; readonly column: string };
  /** For the types whose meaning depends on the database (Oracle's DATE has a time). */
  readonly driver?: DriverId;
}

/** Name rules for text columns, the first match wins. */
const TEXT_NAMES: readonly (readonly [RegExp, GeneratorKind])[] = [
  [/e_?mail/u, 'email'],
  [/(^|_)(first|given)_?name/u, 'firstName'],
  [/(^|_)(last|sur|family)_?name/u, 'lastName'],
  [/user_?name|(^|_)login|nick/u, 'username'],
  [/(^|_)(full_?name|name|display_?name|author|contact)$/u, 'fullName'],
  [/phone|mobile|(^|_)tel$|(^|_)fax/u, 'phone'],
  [/company|organi[sz]ation|employer|(^|_)org$/u, 'company'],
  [/city|town/u, 'city'],
  [/country_?(code|iso)|(^|_)iso_?code/u, 'countryCode'],
  [/country/u, 'country'],
  [/(^|_)ip(_?addr(ess)?)?$/u, 'ip'],
  [/address|street/u, 'address'],
  [/(^|_)(zip|postal|post)_?(code)?$/u, 'postalCode'],
  [/url|website|link|homepage|avatar|image|photo/u, 'url'],
  [/colou?r/u, 'color'],
  [/currency/u, 'currency'],
  [/(^|_)status$/u, 'status'],
  [/uuid|guid/u, 'uuid'],
  [/title|subject|headline|label|(^|_)tags?$/u, 'words'],
  [/descr|(^|_)text$|body|content|comment|note|bio|summary|message|about/u, 'sentence'],
];

/** Name rules for numeric columns. */
const NUMBER_NAMES: readonly (readonly [RegExp, GeneratorKind])[] = [
  [/(^|_)lat(itude)?$/u, 'latitude'],
  [/(^|_)(lng|lon|long|longitude)$/u, 'longitude'],
  [/price|amount|cost|total|salary|balance|fee|sum/u, 'price'],
];

/** `camelCase` and `kebab-case` become `snake_case`, so one set of rules fits all. */
export function normalizedName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .replace(/[\s-]+/gu, '_')
    .toLowerCase();
}

/** The generator a column most likely wants. */
export function suggestGenerator(column: PlanColumn): GeneratorKind {
  if (column.autoIncrement || column.generated) {
    return 'default';
  }
  if (column.reference !== undefined) {
    return 'reference';
  }
  const kind = inputKindOf(column.dataType, column.driver);
  const name = normalizedName(column.name);
  if (column.unique && kind === 'integer') {
    return 'sequence';
  }
  if (kind === 'integer' || kind === 'number') {
    const rule = NUMBER_NAMES.find(([pattern]) => pattern.test(name));
    if (rule !== undefined && (kind === 'number' || rule[1] === 'price')) {
      return rule[1];
    }
    return kind === 'integer' ? 'integer' : 'decimal';
  }
  switch (kind) {
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'datetime':
      return 'datetime';
    case 'enum':
      return 'enum';
    case 'json':
      return 'json';
    case 'binary':
      return 'binary';
    case 'text':
      break;
  }
  if (/^uuid$|uniqueidentifier/iu.test(column.dataType.trim())) {
    return 'uuid';
  }
  return TEXT_NAMES.find(([pattern]) => pattern.test(name))?.[1] ?? 'words';
}

/** What the type itself allows: lengths, ranges, scale, the values of an enum. */
export function typeSettings(column: PlanColumn, kind: GeneratorKind): GeneratorSettings {
  const type = clickhouseBareType(column.dataType).toLowerCase();
  // Oracle says what a length counts: VARCHAR2(60 CHAR), CHAR(4 BYTE).
  const length =
    /^(?:national\s+)?n?(var)?char(?:acter)?2?(?:\s+varying)?\s*\((\d+)(?:\s+(?:char|byte))?\)/u.exec(
      type,
    );
  const varying = length?.[1] !== undefined || /varying|varchar/u.test(type);
  const decimal = /^(?:decimal|numeric|dec|fixed|number)\s*\((\d+)\s*(?:,\s*(\d+))?\)/u.exec(type);
  const settings: {
    -readonly [K in keyof GeneratorSettings]: GeneratorSettings[K];
  } = { kind, ...(column.unique ? { unique: true } : {}) };
  if (length?.[2] !== undefined) {
    settings.maxLength = Number(length[2]);
    if (!varying) {
      settings.fixedLength = true;
    }
  }
  if (decimal !== null) {
    const precision = Number(decimal[1]);
    const scale = Number(decimal[2] ?? 0);
    settings.scale = scale;
    settings.max = Math.min(10 ** Math.max(0, precision - scale) - 1, 10_000);
  } else if (inputKindOf(type, column.driver) === 'number') {
    settings.scale = 2;
  }
  Object.assign(settings, integerRange(type));
  const options = enumOptions(column.dataType);
  if (options !== undefined) {
    settings.choices = options;
  }
  return settings;
}

function integerRange(type: string): { min?: number; max?: number } {
  // ClickHouse names say the width: Int8, UInt16, …
  const sized = /^(u?)int(8|16)$/u.exec(type);
  if (sized !== null) {
    const unsigned = sized[1] === 'u';
    return sized[2] === '8'
      ? { min: unsigned ? 0 : 1, max: unsigned ? 255 : 127 }
      : { min: 1, max: 32_000 };
  }
  if (/^u?int(32|64|128|256)$/u.test(type)) {
    return { min: 1, max: 100_000 };
  }
  const unsigned = type.includes('unsigned');
  if (/^tinyint\s*\(\s*1\s*\)/u.test(type)) {
    return { min: 0, max: 1 };
  }
  if (type.startsWith('tinyint')) {
    return { min: unsigned ? 0 : 1, max: unsigned ? 255 : 127 };
  }
  if (/^(smallint|int2|smallserial)/u.test(type)) {
    return { min: 1, max: 32_000 };
  }
  if (type.startsWith('year')) {
    return { min: 1990, max: 2030 };
  }
  if (/^(mediumint|int|integer|bigint|int4|int8|serial|bigserial)/u.test(type)) {
    return { min: 1, max: 100_000 };
  }
  return {};
}
