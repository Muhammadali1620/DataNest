// What the cell editor needs to decide, free of Svelte so it is tested directly:
// which control a column gets and what text it starts with.

import { cellText } from '../../../../src/shared/cell-text';
import type { InputKind } from '../../../../src/shared/cell-input';
import type { CellValue } from '../../../../src/shared/cell-value';

/** The shape the host sends per editable column. */
export interface EditColumn {
  readonly dataType: string;
  readonly kind: InputKind;
  readonly nullable: boolean;
  readonly options?: readonly string[] | undefined;
}

export type EditorControl =
  | { readonly type: 'input'; readonly inputType: 'text' | 'date'; readonly placeholder?: string }
  | { readonly type: 'select'; readonly options: readonly string[] };

/** The placeholder says how to spell a value the browser has no good control for. */
const PLACEHOLDERS: Partial<Record<InputKind, string>> = {
  time: 'HH:MM:SS',
  datetime: 'YYYY-MM-DD HH:MM:SS',
  json: '{"key": "value"}',
};

export function controlFor(column: EditColumn): EditorControl {
  if (column.kind === 'boolean') {
    return { type: 'select', options: ['true', 'false'] };
  }
  if (column.kind === 'enum' && column.options !== undefined) {
    return { type: 'select', options: column.options };
  }
  if (column.kind === 'date') {
    return { type: 'input', inputType: 'date' };
  }
  const placeholder = PLACEHOLDERS[column.kind];
  return {
    type: 'input',
    inputType: 'text',
    ...(placeholder === undefined ? {} : { placeholder }),
  };
}

/** The text an editor opens with: the exact value, NULL as an empty field. */
export function initialText(value: CellValue): string {
  return value === null ? '' : cellText(value);
}

/** A column the grid lets the user edit. */
export function isEditableColumn(column: EditColumn | null | undefined): column is EditColumn {
  return column !== null && column !== undefined && column.kind !== 'binary';
}
