// The result panel. Rows stay in the host and the page asks for the range it can
// show (ARCHITECTURE.md D6), so a million-row result costs the webview nothing.

import { resultRowSchema } from '../cell-value';
import { READ_ONLY_REASONS } from '../read-only-reason';
import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, literal, number, object, optional, string } from '../schema';

/** Rows the page may ask for in one request. */
export const MAX_WINDOW_ROWS = 2000;

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
  /** Whether rows can be edited in place, and why not when they cannot. */
  edit: optional(
    object({
      editable: boolean(),
      reason: optional(literal(...READ_ONLY_REASONS)),
    }),
  ),
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
      /** Page → host: show another page of a table view. */
      pageTo: {
        params: object({ resultId, offset: number({ integer: true, min: 0 }) }),
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
