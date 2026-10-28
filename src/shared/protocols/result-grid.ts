// The result panel. Rows stay in the host and the page asks for the range it can
// show (ARCHITECTURE.md D6), so a million-row result costs the webview nothing.

import { MAX_BINARY_VIEW_BYTES } from '../binary-bytes';
import { resultRowSchema } from '../cell-value';
import { INPUT_KINDS } from '../cell-input';
import { READ_ONLY_REASONS } from '../read-only-reason';
import { tableFilterSchema } from '../table-filter';
import { defineProtocol } from '../rpc';
import {
  array,
  boolean,
  type Infer,
  literal,
  nullable,
  number,
  object,
  optional,
  string,
  union,
} from '../schema';

/** Rows the page may ask for in one request. */
export const MAX_WINDOW_ROWS = 2000;

/** Rows one row action may name; a guard against a nonsense payload. */
export const MAX_ACTION_ROWS = 100_000;

/** Rows the page keeps around the visible range. */
export const WINDOW_OVERSCAN = 50;

/** Longest text the page may ask the host to copy. */
export const MAX_CLIPBOARD_CHARS = 20_000_000;

/** Matching rows one search returns; enough to walk through, cheap to send. */
export const MAX_SEARCH_HITS = 1000;

/** Longest search text; a longer one is the user leaning on the keyboard. */
export const MAX_SEARCH_LENGTH = 1000;

const resultId = string({ minLength: 1, maxLength: 100 });
const name = string({ maxLength: 1000 });

const columnSchema = object({
  name,
  dataType: optional(string({ maxLength: 200 })),
});

const errorSchema = object({
  code: string({ maxLength: 100 }),
  message: string({ maxLength: 10_000 }),
  position: optional(number({ integer: true, min: 0 })),
});

/** One result tab: everything except the rows themselves. */
const tabSchema = object({
  id: resultId,
  /** The statement, shortened for the tab title. */
  title: name,
  /** The statement in full, for the tooltip. */
  statement: string({ maxLength: 100_000 }),
  columns: array(columnSchema, { maxLength: 10_000 }),
  rowCount: number({ integer: true, min: 0 }),
  truncated: boolean(),
  affectedRows: optional(number({ integer: true, min: 0 })),
  durationMs: number({ min: 0 }),
  error: optional(errorSchema),
  /** Set for a table view: which page is shown and how big the table is. */
  page: optional(
    object({
      offset: number({ integer: true, min: 0 }),
      pageSize: number({ integer: true, min: 1 }),
      totalRows: optional(number({ integer: true, min: 0 })),
    }),
  ),
  /** The server-side filter a table view is read with. */
  filter: optional(tableFilterSchema),
  /** Whether rows can be edited in place, and why not when they cannot. */
  edit: optional(
    object({
      editable: boolean(),
      reason: optional(literal(...READ_ONLY_REASONS)),
      /** Per result column how to edit it; null for a computed column. */
      columns: optional(
        array(
          nullable(
            object({
              dataType: name,
              kind: literal(...INPUT_KINDS),
              nullable: boolean(),
              options: optional(array(string({ maxLength: 1000 }), { maxLength: 1000 })),
            }),
          ),
          { maxLength: 10_000 },
        ),
      ),
    }),
  ),
  /** Cells changed in rows that exist on the server. */
  changedCells: number({ integer: true, min: 0 }),
  /** New rows waiting to be inserted; the grid shows them after the others. */
  insertedRows: number({ integer: true, min: 0 }),
  /** Rows marked for deletion. */
  deletedRows: number({ integer: true, min: 0 }),
  /** Grows with every pending-change update; a page reloads its rows when it moves. */
  revision: number({ integer: true, min: 0 }),
  /** How the result is ordered right now; absent means the server's own order. */
  sort: optional(
    object({
      column: number({ integer: true, min: 0 }),
      direction: literal('asc', 'desc'),
    }),
  ),
});

const stateSchema = object({
  tabs: array(tabSchema, { maxLength: 100 }),
  /** The tab to show; absent when there are none. */
  activeId: optional(resultId),
  /** True while a statement of this document is still running. */
  running: boolean(),
});

const windowSchema = object({
  resultId,
  offset: number({ integer: true, min: 0 }),
  rows: array(resultRowSchema, { maxLength: MAX_WINDOW_ROWS }),
  /** Total rows the result holds, so the page can size its scrollbar. */
  rowCount: number({ integer: true, min: 0 }),
  /** Cells in this window with a pending change; the rows already show their new values. */
  changes: array(
    object({
      row: number({ integer: true, min: 0 }),
      column: number({ integer: true, min: 0 }),
      kind: literal('value', 'default'),
    }),
    { maxLength: MAX_WINDOW_ROWS * 100 },
  ),
  /** Which rows of this window are new or marked for deletion. */
  states: array(
    object({
      row: number({ integer: true, min: 0 }),
      state: literal('inserted', 'deleted'),
    }),
    { maxLength: MAX_WINDOW_ROWS },
  ),
});

const editInput = union(
  object({ kind: literal('text'), text: string({ maxLength: MAX_CLIPBOARD_CHARS }) }),
  object({ kind: literal('null') }),
  object({ kind: literal('default') }),
);

/** Why an edit was refused; the page turns each into a sentence. */
export const EDIT_ERRORS = [
  'not-editable',
  'no-such-row',
  'row-deleted',
  'read-only-column',
  'not-null',
  'invalid-integer',
  'invalid-number',
  'invalid-boolean',
  'invalid-date',
  'invalid-time',
  'invalid-datetime',
  'invalid-json',
  'invalid-enum',
  'unsupported',
] as const;

export const resultGridProtocol = defineProtocol({
  host: {
    requests: {
      /**
       * Page → host: order the result by a column, or restore the server's order
       * when no direction is given. The host answers with the new tab state.
       */
      sort: {
        params: object({
          resultId,
          column: number({ integer: true, min: 0 }),
          direction: optional(literal('asc', 'desc')),
        }),
        result: object({ resultId, applied: boolean() }),
      },
      /** Page → host: show another page of a table view. */
      pageTo: {
        params: object({ resultId, offset: number({ integer: true, min: 0 }) }),
        result: object({ resultId, applied: boolean() }),
      },
      /**
       * Page → host: read a table view again with these conditions; `null` removes the
       * filter. The host answers with the new tab state.
       */
      filterTable: {
        params: object({ resultId, filter: nullable(tableFilterSchema) }),
        result: object({ resultId, applied: boolean() }),
      },
      /** Page → host: which rows contain this text. */
      search: {
        params: object({ resultId, text: string({ maxLength: MAX_SEARCH_LENGTH }) }),
        result: object({
          resultId,
          rows: array(number({ integer: true, min: 0 }), { maxLength: MAX_SEARCH_HITS }),
          total: number({ integer: true, min: 0 }),
        }),
      },
      /** Page → host: change one cell; the change is queued, not saved. */
      editCell: {
        params: object({
          resultId,
          row: number({ integer: true, min: 0 }),
          column: number({ integer: true, min: 0 }),
          input: editInput,
        }),
        result: object({ ok: boolean(), error: optional(literal(...EDIT_ERRORS)) }),
      },
      /** Page → host: add, duplicate, delete or restore rows; queued, not saved. */
      rowAction: {
        params: object({
          resultId,
          action: literal('add', 'duplicate', 'delete', 'restore', 'revert'),
          rows: array(number({ integer: true, min: 0 }), { maxLength: MAX_ACTION_ROWS }),
        }),
        result: object({
          ok: boolean(),
          error: optional(literal(...EDIT_ERRORS)),
          /** Where the first new row is shown, so the page can scroll to it. */
          row: optional(number({ integer: true, min: 0 })),
        }),
      },
      /**
       * Page → host: write the pending changes to the database in one transaction.
       * On failure nothing is saved and the changes stay queued.
       */
      saveChanges: {
        params: object({ resultId }),
        result: object({
          ok: boolean(),
          /** Why it failed, in the user's words. */
          message: optional(string({ maxLength: 10_000 })),
          /** The statement that failed, when one did. */
          statement: optional(string({ maxLength: 100_000 })),
          /** Statements that ran. */
          statements: optional(number({ integer: true, min: 0 })),
          /** False when saved but the rows could not be read again. */
          refreshed: optional(boolean()),
        }),
      },
      /** Page → host: open the SQL a save would run, in a new editor. */
      previewChanges: {
        params: object({ resultId }),
        result: object({ ok: boolean(), message: optional(string({ maxLength: 10_000 })) }),
      },
      /** Page → host: throw every pending change away. */
      discardChanges: {
        params: object({ resultId }),
        result: object({ ok: boolean() }),
      },
      /**
       * Page → host: the whole bytes of a binary cell, for the value panel. `data` is
       * base64 and absent when the value was too large to keep or is no longer there.
       */
      binaryBytes: {
        params: object({
          resultId,
          row: number({ integer: true, min: 0 }),
          column: number({ integer: true, min: 0 }),
        }),
        result: object({
          size: number({ integer: true, min: 0 }),
          data: optional(string({ maxLength: Math.ceil(MAX_BINARY_VIEW_BYTES / 3) * 4 })),
        }),
      },
      /** Page → host: the rows of a visible range. */
      rows: {
        params: object({
          resultId,
          offset: number({ integer: true, min: 0 }),
          limit: number({ integer: true, min: 1, max: MAX_WINDOW_ROWS }),
        }),
        result: windowSchema,
      },
    },
    events: {
      /** The page script has started and listens for messages. */
      ready: object({}),
      /** The user switched to another result tab. */
      selectTab: object({ resultId }),
      /** The user asked to stop the running statement. */
      cancel: object({}),
      /**
       * Page → host: put this on the clipboard. The host writes it, because a
       * webview may not have clipboard permission of its own.
       */
      copyText: object({ text: string({ maxLength: MAX_CLIPBOARD_CHARS }) }),
      /** Page → host: put the cursor where this result's error is. */
      revealError: object({ resultId }),
      /** Page → host: write this result to a file the user picks. */
      exportResult: object({ resultId, format: literal('csv', 'json') }),
    },
  },
  webview: {
    requests: {},
    events: {
      /** Host → page: which tabs exist and which one is shown. */
      state: stateSchema,
    },
  },
});

export type ResultGridProtocol = typeof resultGridProtocol;
export type ResultTab = Infer<typeof tabSchema>;
export type ResultGridState = Infer<typeof stateSchema>;
export type RowWindow = Infer<typeof windowSchema>;
export type ResultColumnInfo = Infer<typeof columnSchema>;

/** A one-line title for a tab: the first words of the statement. */
export function tabTitle(statement: string, maxLength = 40): string {
  const flat = statement.replace(/\s+/gu, ' ').trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}
