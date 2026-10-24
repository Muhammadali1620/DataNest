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
