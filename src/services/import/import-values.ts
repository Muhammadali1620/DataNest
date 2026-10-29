// A value of a CSV or JSON file as a value of a table column (V5.3), by the column's
// type, with the same rules the grid applies to typed input (shared/cell-input.ts):
// a value that does not fit is refused with a reason, never guessed.

import {
  enumOptions,
  inputKindOf,
  type InputProblem,
  parseCellInput,
} from '../../shared/cell-input';
import type { CellValue } from '../../shared/cell-value';
import type { DriverId } from '../../shared/connection';
import type { JsonField } from './json-parser';

/** What a file holds in one field: CSV gives text, JSON a little more. */
export type SourceValue = string | JsonField | undefined;

export interface ValueOptions {
  /** An empty CSV field is NULL rather than an empty string. */
  readonly emptyIsNull: boolean;
  /** Text that stands for NULL, e.g. `\N` or `NULL`; empty for none. */
  readonly nullText: string;
}

export type ImportProblem = InputProblem | 'invalid-binary' | 'not-a-value';

export type Converted =
  | { readonly ok: true; readonly value: CellValue }
  | { readonly ok: false; readonly problem: ImportProblem };

/** Converts one field for a column of `dataType` (of `driver`'s database). Never throws. */
export function convertValue(
  source: SourceValue,
  dataType: string,
  options: ValueOptions,
  driver?: DriverId,
): Converted {
  if (source === undefined || source === null) {
    return { ok: true, value: null };
  }
  const kind = inputKindOf(dataType, driver);
  if (typeof source === 'boolean') {
    // A JSON true goes into a boolean column, and into a 0/1 integer one.
    if (kind === 'integer') {
      return { ok: true, value: source ? 1 : 0 };
    }
    return parseCellInput(kind, source ? 'true' : 'false');
  }
  if (typeof source === 'object') {
    const text = 'number' in source ? source.number : source.json;
    if ('json' in source && kind !== 'json' && kind !== 'text') {
      return { ok: false, problem: 'not-a-value' };
    }
    return kind === 'json' ? parseCellInput('json', text) : convertText(text, kind, dataType);
  }
  if (options.nullText !== '' && source === options.nullText) {
    return { ok: true, value: null };
  }
  if (source === '' && (options.emptyIsNull || kind !== 'text')) {
    return { ok: true, value: null };
  }
  return convertText(source, kind, dataType);
}

/** MySQL's BOOLEAN is TINYINT(1): files write true/false into it. */
const MYSQL_BOOLEAN = /^tinyint\s*\(\s*1\s*\)/iu;

function convertText(
  text: string,
  kind: ReturnType<typeof inputKindOf>,
  dataType: string,
): Converted {
  if (kind === 'integer' && MYSQL_BOOLEAN.test(dataType)) {
    const flag = parseCellInput('boolean', text.trim());
    if (flag.ok && typeof flag.value === 'boolean') {
      return { ok: true, value: flag.value ? 1 : 0 };
    }
  }
  switch (kind) {
    case 'text':
      return { ok: true, value: text };
    case 'binary':
      return binaryOf(text.trim());
    case 'enum':
      return parseCellInput('enum', text, enumOptions(dataType));
    case 'integer':
    case 'number':
    case 'boolean':
    case 'date':
    case 'time':
    case 'datetime':
    case 'json':
      return parseCellInput(kind, text.trim());
  }
}

/** `0x…` or `\x…` hex; anything else is refused rather than stored as its letters. */
function binaryOf(text: string): Converted {
  const hex = /^(?:0x|\\x)([0-9a-f]*)$/iu.exec(text)?.[1];
  if (hex === undefined || hex.length % 2 !== 0) {
    return { ok: false, problem: 'invalid-binary' };
  }
  return { ok: true, value: { kind: 'binary', size: hex.length / 2, preview: hex.toLowerCase() } };
}
