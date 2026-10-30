// The data comparison page (V8.4): the host compares the rows of two tables and keeps
// the rows to show; the page asks for them a page at a time and for the sync script.

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

const NAME = 1000;
const CELL = 100_000;
/** Rows the page asks for at once. */
export const ROWS_PAGE = 200;

export const ROW_KINDS = ['different', 'onlySource', 'onlyTarget'] as const;

const pairSchema = object({
  source: string({ maxLength: NAME }),
  target: string({ maxLength: NAME }),
});
const countSchema = number({ integer: true, min: 0 });

const stateSchema = object({
  source: string({ maxLength: NAME * 3 }),
  target: string({ maxLength: NAME * 3 }),
  key: array(pairSchema, { maxLength: 1000 }),
  columns: array(pairSchema, { maxLength: 10_000 }),
  sourceOnly: array(string({ maxLength: NAME }), { maxLength: 10_000 }),
  targetOnly: array(string({ maxLength: NAME }), { maxLength: 10_000 }),
  progress: optional(object({ phase: literal('target', 'source', 'rows'), rows: countSchema })),
  result: optional(
    object({
      same: countSchema,
      different: countSchema,
      onlySource: countSchema,
      onlyTarget: countSchema,
      /** How many rows of each kind the host kept to show and to sync. */
      kept: object({ different: countSchema, onlySource: countSchema, onlyTarget: countSchema }),
      durationMs: number({ min: 0 }),
    }),
  ),
  error: optional(string({ maxLength: CELL })),
});

const rowSchema = object({
  /** Cell texts, key first, null for NULL: the source's, or the only side's. */
  cells: array(nullable(string({ maxLength: CELL })), { maxLength: 11_000 }),
  /** For a row that differs: the target's texts, and which compared columns differ. */
  target: optional(array(nullable(string({ maxLength: CELL })), { maxLength: 11_000 })),
  differs: optional(array(boolean(), { maxLength: 11_000 })),
});

export const dataCompareProtocol = defineProtocol({
  host: {
    requests: {
      rows: {
        params: object({
          kind: literal(...ROW_KINDS),
          offset: countSchema,
          limit: number({ integer: true, min: 1, max: ROWS_PAGE }),
        }),
        result: object({ rows: array(rowSchema, { maxLength: ROWS_PAGE }) }),
      },
      /** Opens the sync script of the chosen parts in an editor on the target. */
      openScript: {
        params: object({ insert: boolean(), update: boolean(), delete: boolean() }),
        result: object({ opened: boolean() }),
      },
    },
    events: {
      ready: object({}),
      refresh: object({}),
      cancel: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      state: stateSchema,
    },
  },
});

export type DataCompareProtocol = typeof dataCompareProtocol;
export type DataCompareState = Infer<typeof stateSchema>;
export type DataCompareRow = Infer<typeof rowSchema>;
export type RowKind = (typeof ROW_KINDS)[number];
