// The documents page of a MongoDB collection (V7.6): a page of documents as a table and
// as text in the shell's syntax, a filter, a sort and a projection, and editing. The host
// parses what the user types, runs every command and asks before changing production; it
// sends the page only what it shows, already formatted (D89).

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
} from '../schema';

/** Documents one page may hold. */
export const PAGE_SIZES = [20, 50, 100, 200, 500] as const;
export const DEFAULT_PAGE_SIZE = 50;
/** Characters of a document's text the page gets; a longer one is cut and cannot be edited there. */
export const MAX_DOCUMENT_TEXT = 256 * 1024;
/** Characters of a cell. */
export const MAX_CELL_TEXT = 200;
/** Characters of what the user types into the filter, sort and projection boxes, or a document. */
export const MAX_QUERY_TEXT = 100_000;
export const MAX_EDIT_TEXT = 16 * 1024 * 1024;

const queryText = string({ maxLength: MAX_QUERY_TEXT });

export const documentQuerySchema = object({
  filter: queryText,
  sort: queryText,
  projection: queryText,
  limit: number({ integer: true, min: 1, max: 500 }),
});

/** A value in a cell: its preview, and its BSON type so it can be styled; null when missing. */
const cellSchema = nullable(
  object({
    text: string({ maxLength: MAX_CELL_TEXT * 2 }),
    type: string({ maxLength: 20 }),
  }),
);

const rowSchema = object({
  /** The row's place on the page, which requests name. */
  index: number({ integer: true, min: 0 }),
  /** The `_id` in the shell's syntax; absent when the document has none. */
  id: optional(string({ maxLength: MAX_CELL_TEXT * 2 })),
  /** One per column, in the order of `columns`. */
  cells: array(cellSchema, { maxLength: 10_000 }),
  /** The document laid out in the shell's syntax, cut at MAX_DOCUMENT_TEXT. */
  text: string({ maxLength: MAX_DOCUMENT_TEXT + 100 }),
  truncated: boolean(),
  /** Bytes of BSON. */
  size: number({ integer: true, min: 0 }),
});

/** Where a text the user typed is wrong, so the page can point at it. */
export const typedProblemSchema = object({
  message: string({ maxLength: 2000 }),
  box: literal('filter', 'sort', 'projection', 'document'),
  line: optional(number({ integer: true, min: 1 })),
  column: optional(number({ integer: true, min: 1 })),
});

const stateSchema = object({
  connectionName: string({ maxLength: 500 }),
  database: string({ maxLength: 500 }),
  collection: string({ maxLength: 500 }),
  collectionType: literal('collection', 'view', 'timeseries'),
  /** The connection refuses every change. */
  readOnly: boolean(),
  /** Documents may be edited and deleted here (not in a view or a time series). */
  editable: boolean(),
  /** Documents may be added (not in a view). */
  insertable: boolean(),
  query: documentQuerySchema,
  /** Documents skipped before the page. */
  skip: number({ integer: true, min: 0 }),
  /** Top-level fields of the page, `_id` first, then as they first appear. */
  columns: array(string({ maxLength: 10_000 }), { maxLength: 10_000 }),
  rows: array(rowSchema, { maxLength: 500 }),
  /** More documents follow this page. */
  more: boolean(),
  tookMs: number({ integer: true, min: 0 }),
  /** How many documents match; absent while unknown (the count took too long). */
  total: optional(object({ count: string({ maxLength: 30 }), exact: boolean() })),
  /** Why the last read failed; the page keeps the documents it had. */
  error: optional(typedProblemSchema),
});

const rowsParams = object({ rows: array(number({ integer: true, min: 0 }), { maxLength: 500 }) });

export const mongoDocumentsProtocol = defineProtocol({
  host: {
    requests: {
      /** Reads the first page of what the query finds. */
      run: { params: documentQuerySchema, result: object({}) },
      /** Reads the page that starts after `skip` documents, with the query in force. */
      page: { params: object({ skip: number({ integer: true, min: 0 }) }), result: object({}) },
      refresh: { params: object({}), result: object({}) },
      /** Counts the documents that match even when that takes long. */
      count: { params: object({}), result: object({}) },
      /**
       * The whole document of a row, read again from the server, to edit; `token` names
       * that version in `save`.
       */
      edit: {
        params: object({ row: number({ integer: true, min: 0 }) }),
        result: object({
          token: string({ maxLength: 100 }),
          text: string({ maxLength: MAX_EDIT_TEXT }),
        }),
      },
      /** Replaces the document read for `token` with `text`, if it is unchanged meanwhile. */
      save: {
        params: object({
          token: string({ maxLength: 100 }),
          text: string({ maxLength: MAX_EDIT_TEXT }),
        }),
        result: object({ problem: optional(typedProblemSchema) }),
      },
      /** Adds a document; one without `_id` gets an ObjectId. */
      insert: {
        params: object({ text: string({ maxLength: MAX_EDIT_TEXT }) }),
        result: object({ problem: optional(typedProblemSchema) }),
      },
      /** Deletes the documents of these rows after the user agrees. */
      delete: {
        params: rowsParams,
        result: object({ deleted: number({ integer: true, min: 0 }) }),
      },
      /** Puts the documents of these rows on the clipboard as text. */
      copy: { params: rowsParams, result: object({}) },
    },
    events: {
      /** The page script has started and listens for messages. */
      ready: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      /** Host → page: everything to render, after every read and change (D21). */
      state: stateSchema,
    },
  },
});

export type MongoDocumentsProtocol = typeof mongoDocumentsProtocol;

export type MongoDocumentsState = Infer<typeof stateSchema>;

export type MongoDocumentRow = Infer<typeof rowSchema>;

export type DocumentQueryText = Infer<typeof documentQuerySchema>;

export type TypedProblem = Infer<typeof typedProblemSchema>;
