// SQL Server values as CellValue (ARCHITECTURE.md §5). Exact types arrive already as
// the server's text (exact-values.ts); BIGINT comes from tedious as text too.

import type { CellValue } from '../../shared/cell-value';
import { binaryValue, safeIntOrTag } from '../common/values';
import { ExactText } from './exact-values';

/** The slice of tedious' column metadata the driver reads. */
export interface ColumnMetadataLike {
  readonly colName?: string;
  readonly type: { readonly name: string };
  readonly dataLength?: number | undefined;
  readonly precision?: number | undefined;
  readonly scale?: number | undefined;
  readonly udtInfo?: { readonly typeName?: string } | undefined;
}

// A Map, not an object literal: a type named like `toString` must find nothing.
const TYPE_NAMES: ReadonlyMap<string, string> = new Map([
  ['TinyInt', 'tinyint'],
  ['SmallInt', 'smallint'],
  ['Int', 'int'],
  ['BigInt', 'bigint'],
  ['Real', 'real'],
  ['Float', 'float'],
  ['Bit', 'bit'],
  ['BitN', 'bit'],
  ['Money', 'money'],
  ['SmallMoney', 'smallmoney'],
  ['DecimalN', 'decimal'],
  ['NumericN', 'numeric'],
  ['Char', 'char'],
  ['VarChar', 'varchar'],
  ['NChar', 'nchar'],
  ['NVarChar', 'nvarchar'],
  ['Text', 'text'],
  ['NText', 'ntext'],
  ['Binary', 'binary'],
  ['VarBinary', 'varbinary'],
  ['Image', 'image'],
  ['Date', 'date'],
  ['Time', 'time'],
  ['DateTime', 'datetime'],
  ['SmallDateTime', 'smalldatetime'],
  ['DateTime2', 'datetime2'],
  ['DateTimeOffset', 'datetimeoffset'],
  ['UniqueIdentifier', 'uniqueidentifier'],
  ['Xml', 'xml'],
  ['Variant', 'sql_variant'],
]);

/** The type of a result column as SQL names it; the `N` variants by their length. */
export function mssqlTypeName(metadata: ColumnMetadataLike): string | undefined {
  const name = metadata.type.name;
  switch (name) {
    case 'IntN':
      return { 1: 'tinyint', 2: 'smallint', 4: 'int', 8: 'bigint' }[metadata.dataLength ?? 4];
    case 'FloatN':
      return metadata.dataLength === 4 ? 'real' : 'float';
    case 'MoneyN':
      return metadata.dataLength === 4 ? 'smallmoney' : 'money';
    case 'DateTimeN':
      return metadata.dataLength === 4 ? 'smalldatetime' : 'datetime';
    case 'UDT':
      return metadata.udtInfo?.typeName?.toLowerCase();
    default:
      return TYPE_NAMES.get(name);
  }
}

/** Normalizes one value tedious produced, using the column's metadata. */
export function toCellValue(value: unknown, metadata: ColumnMetadataLike): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof ExactText) {
    return { kind: value.kind, text: value.text };
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return safeIntOrTag(value.toString());
  }
  if (typeof value === 'string') {
    const type = metadata.type.name;
    // tedious reads BIGINT as text to keep it exact.
    return type === 'BigInt' || (type === 'IntN' && metadata.dataLength === 8)
      ? safeIntOrTag(value)
      : value;
  }
  if (Buffer.isBuffer(value)) {
    return binaryValue(value);
  }
  if (value instanceof Date) {
    // Only inside sql_variant, where tedious' own decoders run: UTC, to the millisecond.
    return { kind: 'datetime', text: value.toISOString().replace('T', ' ').replace('Z', '') };
  }
  // Nothing else reaches here today; JSON keeps whatever it is readable.
  return JSON.stringify(value);
}

/** Catalog values: text as it is, numbers and exact values as text. */
export function catalogText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof ExactText) {
    return value.text;
  }
  return undefined;
}
