// The result page of an Elasticsearch request (V7.8): the answer's status, the hits of a
// search as a table, and the whole answer as text. The host parses and formats it; the
// page shows what it gets and asks for copies.

import { defineProtocol } from '../rpc';
import { array, type Infer, literal, nullable, number, object, optional, string } from '../schema';

/** Characters of the answer's text the page gets; a longer one is cut. */
export const MAX_ANSWER_TEXT = 2 * 1024 * 1024;
export const MAX_HIT_TEXT = 64 * 1024;

const cellSchema = nullable(
  object({ text: string({ maxLength: 1000 }), type: string({ maxLength: 20 }) }),
);

const stateSchema = object({
  connectionName: string({ maxLength: 500 }),
  /** `POST /products/_search`. */
  request: string({ maxLength: 10_000 }),
  status: number({ integer: true, min: 0, max: 999 }),
  /** Milliseconds the round trip took. */
  tookMs: number({ integer: true, min: 0 }),
  /** What the answer holds, for the line above the table. */
  summary: optional(
    object({
      kind: literal('hits', 'count', 'error', 'empty'),
      /** Hits that match, decimal text; with `gte` the server stopped counting there. */
      total: optional(string({ maxLength: 30 })),
      relation: optional(literal('eq', 'gte')),
      shown: optional(number({ integer: true, min: 0 })),
      /** Milliseconds the server says the search took. */
      took: optional(number({ integer: true, min: 0 })),
      error: optional(string({ maxLength: 10_000 })),
    }),
  ),
  /** `_index`, `_id`, `_score`, then the fields of `_source` as they first appear. */
  columns: array(string({ maxLength: 10_000 }), { maxLength: 10_000 }),
  rows: array(
    object({
      cells: array(cellSchema, { maxLength: 10_000 }),
      /** The hit laid out, cut at MAX_HIT_TEXT. */
      text: string({ maxLength: MAX_HIT_TEXT + 10 }),
    }),
    { maxLength: 10_000 },
  ),
  /** The whole answer laid out, or as the server wrote it when it is not JSON. */
  text: string({ maxLength: MAX_ANSWER_TEXT + 10 }),
  truncated: literal(true, false),
});

export const elasticResultProtocol = defineProtocol({
  host: {
    requests: {
      /** Puts hits (by row) or, without rows, the whole answer on the clipboard. */
      copy: {
        params: object({
          rows: optional(array(number({ integer: true, min: 0 }), { maxLength: 10_000 })),
        }),
        result: object({}),
      },
    },
    events: { ready: object({}) },
  },
  webview: {
    requests: {},
    events: { state: stateSchema },
  },
});

export type ElasticResultProtocol = typeof elasticResultProtocol;

export type ElasticResultState = Infer<typeof stateSchema>;
