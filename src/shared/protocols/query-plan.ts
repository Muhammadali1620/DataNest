// The query plan page (V8.2): the host runs EXPLAIN on the editor's session and sends
// the plan as rows in tree order with their shares; the page draws the tree and asks
// for another run, with or without ANALYZE.

import { PLAN_WARNINGS } from '../query-plan';
import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, literal, number, object, optional, string } from '../schema';

const TEXT = 100_000;
const MAX_ROWS = 20_000;

const pairSchema = array(string({ maxLength: TEXT }), { maxLength: 2 });

const rowSchema = object({
  depth: number({ integer: true, min: 0, max: 10_000 }),
  operation: string({ maxLength: TEXT }),
  object: optional(string({ maxLength: TEXT })),
  detail: optional(string({ maxLength: TEXT })),
  cost: optional(number()),
  rows: optional(number()),
  actualRows: optional(number()),
  loops: optional(number()),
  timeMs: optional(number()),
  warnings: array(literal(...PLAN_WARNINGS), { maxLength: PLAN_WARNINGS.length }),
  properties: array(pairSchema, { maxLength: 1000 }),
  self: number({ min: 0 }),
  share: number({ min: 0, max: 1 }),
  heat: literal('hot', 'warm', 'mild', 'none'),
  descendants: number({ integer: true, min: 0 }),
});

const stateSchema = object({
  statement: string({ maxLength: 1_000_000 }),
  connection: string({ maxLength: 1000 }),
  /** The server can run the statement for real figures (and it only reads). */
  canAnalyze: boolean(),
  running: boolean(),
  /** Which run the plan is from. */
  analyzed: boolean(),
  basis: literal('time', 'cost', 'none'),
  rows: array(rowSchema, { maxLength: MAX_ROWS }),
  properties: array(pairSchema, { maxLength: 1000 }),
  notes: array(string({ maxLength: TEXT }), { maxLength: 1000 }),
  error: optional(string({ maxLength: TEXT })),
});

export const queryPlanProtocol = defineProtocol({
  host: {
    requests: {},
    events: {
      ready: object({}),
      /** Explains the statement again; with `analyze` it runs. */
      explain: object({ analyze: boolean() }),
      /** Opens the server's own answer in an editor. */
      showRaw: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      state: stateSchema,
    },
  },
});

export type QueryPlanProtocol = typeof queryPlanProtocol;
export type QueryPlanState = Infer<typeof stateSchema>;
export type QueryPlanRow = Infer<typeof rowSchema>;
