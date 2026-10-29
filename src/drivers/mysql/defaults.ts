// MySQL accepts a default on TEXT, BLOB and JSON columns only as an expression in
// parentheses (MySQL 8.0.13+, MariaDB 10.2+): `DEFAULT ('new')`, not `DEFAULT 'new'`.

import type { ColumnDesign } from '../../shared/table-design';

const NEEDS_EXPRESSION =
  /^(tiny|medium|long)?(text|blob)$|^json$|^(geometry|point|linestring|polygon)$/u;

export function mysqlDefault(column: ColumnDesign): string {
  const value = column.defaultValue.trim();
  const type = column.type.trim().toLowerCase();
  if (!NEEDS_EXPRESSION.test(type) || value.startsWith('(') || /^null$/iu.test(value)) {
    return value;
  }
  return `(${value})`;
}
