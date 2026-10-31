// The result panel. Rows stay in the host and the page asks for the range it can
// show (ARCHITECTURE.md D6), so a million-row result costs the webview nothing.

import { MAX_BINARY_VIEW_BYTES } from '../binary-bytes';
import { COPY_ERRORS, COPY_FORMATS } from '../copy-format';
import { LINK_ERRORS } from '../link-error';
import { MAX_COLUMNS, resultRowSchema } from '../cell-value';
import { INPUT_KINDS } from '../cell-input';
import { READ_ONLY_REASONS } from '../read-only-reason';
import { TABLE_ACTIONS } from '../table-actions';
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

/** Most rows one page of a table view may hold, which is also what "load all" is capped at. */
export const MAX_PAGE_SIZE = 1_000_000;

/** "Load all" asks the user to confirm above this many rows. */
export const LOAD_ALL_WARNING_ROWS = 50_000;

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
      /** True when `totalRows` is the server's estimate, not a count. */
      approximate: optional(boolean()),
    }),
  ),
  /** The server-side filter a table view is read with. */
  filter: optional(tableFilterSchema),
  /** Whether rows can be edited in place, and why not when they cannot. */
  edit: optional(
    object({
      editable: boolean(),
      reason: optional(literal(...READ_ONLY_REASONS)),
      /** The table has no key: rows are found by all their values (V10.2.4). */
      keyless: optional(boolean()),
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
  /** Foreign keys of an editable result: cells in these columns can lead to the row they point at. */
  links: optional(
    array(
      object({
        id: number({ integer: true, min: 0 }),
        columns: array(number({ integer: true, min: 0 }), { maxLength: 100 }),
        target: string({ maxLength: 1000 }),
      }),
      { maxLength: 1000 },
    ),
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
  /** `view` when the page shows a database view: it has no table-only tools. */
  tableKind: optional(literal('view')),
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
  'too-large',
  'not-text',
] as const;

/** The totals of selected cells (V10.2.4); numbers are exact text, as the cells hold them. */
const totalsSchema = object({
  stale: optional(boolean()),
  cells: optional(number({ integer: true, min: 0 })),
  values: optional(number({ integer: true, min: 0 })),
  numbers: optional(number({ integer: true, min: 0 })),
  sum: optional(string({ maxLength: 400 })),
  average: optional(string({ maxLength: 400 })),
  min: optional(string({ maxLength: 400 })),
  max: optional(string({ maxLength: 400 })),
  approximate: optional(boolean()),
});

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
      /** Page → host: change how many rows a page of a table view holds. */
      pageSize: {
        params: object({
          resultId,
          pageSize: number({ integer: true, min: 1, max: MAX_PAGE_SIZE }),
        }),
        result: object({ resultId, applied: boolean() }),
      },
      /**
       * Page → host: put the whole table on one page. The host asks the user first
       * when that is a lot of rows, and `applied` is false when they decline.
       */
      loadAll: {
        params: object({ resultId }),
        result: object({ resultId, applied: boolean() }),
      },
      /** Page → host: replace an estimated row count with a real one. */
      countRows: {
        params: object({ resultId }),
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
          /** A newer search, a sort or fresh rows overtook this one: keep what is shown. */
          stale: optional(boolean()),
        }),
      },
      /**
       * Page → host: put the cells in a rectangle on the clipboard in a chosen format.
       * Without a rectangle the whole result is copied.
       */
      copyAs: {
        params: object({
          resultId,
          format: literal(...COPY_FORMATS),
          top: optional(number({ integer: true, min: 0 })),
          bottom: optional(number({ integer: true, min: 0 })),
          /** The result columns to copy, in the order they are on screen. */
          columns: optional(array(number({ integer: true, min: 0 }), { maxLength: MAX_COLUMNS })),
        }),
        result: object({
          ok: boolean(),
          error: optional(literal(...COPY_ERRORS)),
          /** Rows that were copied. */
          rows: optional(number({ integer: true, min: 0 })),
        }),
      },
      /**
       * Page → host: save the value of a cell to a file the user picks (V10.2.4); the
       * host asks where. `cancelled` when they closed the dialog.
       */
      saveValue: {
        params: object({
          resultId,
          row: number({ integer: true, min: 0 }),
          column: number({ integer: true, min: 0 }),
        }),
        result: object({
          ok: boolean(),
          error: optional(literal('no-value', 'too-large', 'cancelled', 'failed')),
        }),
      },
      /**
       * Page → host: load a file the user picks into a cell; queued like an edit.
       */
      loadValue: {
        params: object({
          resultId,
          row: number({ integer: true, min: 0 }),
          column: number({ integer: true, min: 0 }),
        }),
        result: object({
          ok: boolean(),
          cancelled: optional(boolean()),
          error: optional(literal(...EDIT_ERRORS)),
        }),
      },
      /**
       * Page → host: the totals of a rectangle of cells — count, and for numbers sum,
       * average, minimum and maximum (V10.2.4). `stale` when a newer request, a sort or
       * an edit overtook it.
       */
      summarize: {
        params: object({
          resultId,
          top: number({ integer: true, min: 0 }),
          bottom: number({ integer: true, min: 0 }),
          columns: array(number({ integer: true, min: 0 }), { maxLength: MAX_COLUMNS }),
        }),
        result: totalsSchema,
      },
      /**
       * Page → host: open the row a foreign key cell points at, in the target table's own
       * result panel.
       */
      followLink: {
        params: object({
          resultId,
          row: number({ integer: true, min: 0 }),
          link: number({ integer: true, min: 0 }),
        }),
        result: object({ ok: boolean(), error: optional(literal(...LINK_ERRORS)) }),
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
      /**
       * Page → host: run this statement in the document the result belongs to, like the
       * Run command does (V12.1). `ok: false` carries the server's message in `error`;
       * the new result arrives as a state update.
       */
      runSql: {
        params: object({ resultId, sql: string({ maxLength: 1_000_000 }) }),
        result: object({ ok: boolean(), error: optional(string({ maxLength: 10_000 })) }),
      },
      /** Page → host: the clipboard's text, for a paste a webview may not read itself. */
      clipboardText: {
        params: object({}),
        result: object({ text: string({ maxLength: MAX_CLIPBOARD_CHARS }) }),
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
      /** Page → host: open a chart of this result beside it (V8.7). */
      chartResult: object({ resultId }),
      /** Page → host: write this result to a file the user picks. */
      exportResult: object({
        resultId,
        format: literal('csv', 'json', 'sql', 'markdown', 'xlsx'),
        /**
         * What to write (V12.1): the result with its filter (the default), the whole table
         * without the filter, or every table of the database into a folder.
         */
        scope: optional(literal('result', 'table', 'database')),
      }),
      /** Page → host: open the Tools page (hashes, encoders, colours, images, network). */
      openTools: object({}),
      /** Page → host: run a table tool (properties, ER diagram, history…) on this table view. */
      tableAction: object({
        resultId,
        action: literal(...TABLE_ACTIONS),
        /** Unsaved edits: the host asks before the page is left. */
        dirty: optional(boolean()),
      }),
      /** Page → host: open the import page for the table this result shows (V12.1). */
      importInto: object({ resultId }),
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
export type SelectionTotals = Infer<typeof totalsSchema>;
export type ResultTab = Infer<typeof tabSchema>;
export type ResultGridState = Infer<typeof stateSchema>;
export type RowWindow = Infer<typeof windowSchema>;
export type ResultColumnInfo = Infer<typeof columnSchema>;

/** A one-line title for a tab: the first words of the statement. */
export function tabTitle(statement: string, maxLength = 40): string {
  const flat = statement.replace(/\s+/gu, ' ').trim();
  return flat.length <= maxLength ? flat : `${flat.slice(0, maxLength - 1)}…`;
}
