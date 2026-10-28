// Following a foreign key from a cell to the row it points at (V2.13). The result
// knows which columns are keys of its table; this turns one row's key values into
// "open that table, filtered to this row". Pure of the editor: the caller opens it.

import type { EditableResult } from '../core/model/editability';
import type { ForeignKey, TableRef } from '../core/model/objects';
import type { LinkError } from '../shared/link-error';
import { cellText } from '../shared/cell-text';
import type { SessionTarget } from './connection-manager';
import type { ResultStore } from './result-store';
import type { TableFilter } from '../shared/table-filter';

/** A foreign key of the result as the page needs to draw it. */
export interface ResultLink {
  /** Position in the table's foreign key list; what the page sends back to follow it. */
  readonly id: number;
  /** Result columns that hold the key, in key order. */
  readonly columns: number[];
  /** The target table as text, for a tooltip. */
  readonly target: string;
}

/** Foreign keys whose every column is in the result; a partial key cannot be followed. */
export function linksOf(edit: EditableResult): ResultLink[] {
  return (edit.foreignKeys ?? []).flatMap((key, id) => {
    const columns = key.columns.map((name) => edit.columnMap.indexOf(name));
    return columns.length === 0 || columns.includes(-1)
      ? []
      : [{ id, columns, target: tableLabel(key.target) }];
  });
}

export function tableLabel(table: TableRef): string {
  return [table.database, table.schema, table.name].filter((part) => part !== undefined).join('.');
}

export interface FollowRequest {
  readonly resultId: string;
  readonly row: number;
  readonly link: number;
}

export type FollowOutcome =
  | {
      readonly ok: true;
      readonly target: SessionTarget;
      readonly table: TableRef;
      readonly filter: TableFilter;
    }
  | { readonly ok: false; readonly error: LinkError };

export class ResultLinks {
  constructor(private readonly results: ResultStore) {}

  follow(request: FollowRequest): FollowOutcome {
    const summary = this.results.get(request.resultId);
    const edit = summary?.edit;
    const key: ForeignKey | undefined =
      edit?.editable === true ? edit.foreignKeys?.[request.link] : undefined;
    if (summary?.origin === undefined || edit?.editable !== true || key === undefined) {
      return { ok: false, error: 'no-link' };
    }
    const columns = key.columns.map((name) => edit.columnMap.indexOf(name));
    if (columns.includes(-1)) {
      return { ok: false, error: 'no-link' };
    }
    // The window carries unsaved edits, so the link follows what the grid shows.
    const row = this.results.window(request.resultId, request.row, 1)?.rows[0];
    if (row === undefined) {
      return { ok: false, error: 'no-such-row' };
    }
    const conditions: TableFilter['conditions'][number][] = [];
    for (const [position, column] of columns.entries()) {
      const cell = row[column] ?? null;
      if (cell === null) {
        // A NULL key points at nothing; MATCH SIMPLE keys with one NULL do not either.
        return { ok: false, error: 'null-value' };
      }
      if (typeof cell === 'object' && cell.kind === 'binary') {
        return { ok: false, error: 'unsupported' };
      }
      conditions.push({
        column: key.targetColumns[position] ?? '',
        operator: 'eq',
        value: cellText(cell),
      });
    }
    return { ok: true, target: summary.origin.target, table: key.target, filter: { conditions } };
  }
}
