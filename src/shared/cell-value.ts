import {
  array,
  boolean,
  literal,
  nullable,
  number,
  object,
  type Schema,
  string,
  union,
} from './schema';

// The one value format both sides understand (ARCHITECTURE.md §5). Drivers normalize
// everything a database returns into CellValue, so precision is never lost on the way
// to the grid: bigint/decimal stay text, datetimes keep the server's spelling.

export interface BigIntValue {
  readonly kind: 'bigint';
  readonly text: string;
}

export interface DecimalValue {
  readonly kind: 'decimal';
  readonly text: string;
}

/** Date, time or timestamp exactly as the database returned it, no timezone math. */
export interface DateTimeValue {
  readonly kind: 'datetime';
  readonly text: string;
}

/** Binary data; only a short hex preview travels by default. */
export interface BinaryValue {
  readonly kind: 'binary';
  /** Size in bytes of the full value. */
  readonly size: number;
  /** Hex of the first bytes, e.g. `89504e47…`. */
  readonly preview: string;
}

export interface JsonValue {
  readonly kind: 'json';
  readonly text: string;
}

export type TaggedCellValue = BigIntValue | DecimalValue | DateTimeValue | BinaryValue | JsonValue;

export type CellValue = null | string | number | boolean | TaggedCellValue;

export function isTaggedValue(value: CellValue): value is TaggedCellValue {
  return typeof value === 'object' && value !== null;
}

/** Longest text a single cell may carry to the webview. */
export const MAX_CELL_TEXT_LENGTH = 1_000_000;

const text = string({ maxLength: MAX_CELL_TEXT_LENGTH });

const taggedSchema: Schema<TaggedCellValue> = union(
  object({ kind: literal('bigint'), text }),
  object({ kind: literal('decimal'), text }),
  object({ kind: literal('datetime'), text }),
  object({ kind: literal('json'), text }),
  object({
    kind: literal('binary'),
    size: number({ integer: true, min: 0 }),
    preview: text,
  }),
);

/** Validates a cell crossing the host ↔ webview boundary. */
export const cellValueSchema: Schema<CellValue> = nullable(
  union(string({ maxLength: MAX_CELL_TEXT_LENGTH }), number(), boolean(), taggedSchema),
);

/** How many columns one row may have; a guard against a nonsense payload. */
export const MAX_COLUMNS = 10_000;

export const resultRowSchema = array(cellValueSchema, { maxLength: MAX_COLUMNS });
