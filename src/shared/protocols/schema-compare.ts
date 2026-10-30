// The schema comparison page (V8.3): the host reads both schemas and compares them;
// the page lists the differences, shows one at a time and asks for the script of the
// chosen ones.

import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, literal, number, object, optional, string } from '../schema';

const NAME = 1000;
const TEXT = 2_000_000;
const MAX_ITEMS = 50_000;

export const COMPARE_KINDS = [
  'table',
  'view',
  'function',
  'procedure',
  'trigger',
  'sequence',
  'event',
] as const;

export const COMPARE_STATUSES = ['added', 'removed', 'changed', 'same'] as const;

const itemSchema = object({
  id: string({ maxLength: NAME * 4 }),
  kind: literal(...COMPARE_KINDS),
  name: string({ maxLength: NAME }),
  status: literal(...COMPARE_STATUSES),
  /** The table a trigger belongs to; the arguments of an overloaded routine. */
  context: optional(string({ maxLength: NAME * 2 })),
  /** A definition could not be read, so the item is left out of scripts. */
  hidden: optional(literal(true)),
});

const changeFields = {
  name: string({ maxLength: NAME }),
  change: literal('added', 'removed', 'changed'),
  before: optional(string({ maxLength: TEXT })),
  after: optional(string({ maxLength: TEXT })),
};

const changeSchema = object(changeFields);

const detailSchema = object({
  id: string({ maxLength: NAME * 4 }),
  columns: array(changeSchema, { maxLength: 10_000 }),
  /** Primary key, indexes and foreign keys. */
  keys: array(object({ kind: literal('primaryKey', 'index', 'foreignKey'), ...changeFields }), {
    maxLength: 10_000,
  }),
  comment: optional(
    object({ before: string({ maxLength: TEXT }), after: string({ maxLength: TEXT }) }),
  ),
  notes: array(string({ maxLength: TEXT }), { maxLength: 1000 }),
  /** Target definition against the source one, line by line. */
  diff: array(object({ op: literal('same', 'add', 'remove'), text: string({ maxLength: TEXT }) }), {
    maxLength: 200_000,
  }),
  /** What this difference adds to the script. */
  script: string({ maxLength: TEXT }),
  hidden: optional(string({ maxLength: TEXT })),
});

const stateSchema = object({
  source: string({ maxLength: NAME * 2 }),
  target: string({ maxLength: NAME * 2 }),
  loading: optional(
    object({
      side: literal('source', 'target'),
      done: number({ integer: true, min: 0 }),
      total: number({ integer: true, min: 0 }),
    }),
  ),
  items: array(itemSchema, { maxLength: MAX_ITEMS }),
  error: optional(string({ maxLength: TEXT })),
});

export const schemaCompareProtocol = defineProtocol({
  host: {
    requests: {
      detail: { params: object({ id: string({ maxLength: NAME * 4 }) }), result: detailSchema },
      /** Opens the script of the chosen differences in an editor on the target. */
      openScript: {
        params: object({ ids: array(string({ maxLength: NAME * 4 }), { maxLength: MAX_ITEMS }) }),
        result: object({ opened: boolean() }),
      },
    },
    events: {
      ready: object({}),
      refresh: object({}),
      /** Compares the other way round: the target becomes the source. */
      swap: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      state: stateSchema,
    },
  },
});

export type SchemaCompareProtocol = typeof schemaCompareProtocol;
export type SchemaCompareState = Infer<typeof stateSchema>;
export type SchemaCompareItem = Infer<typeof itemSchema>;
export type SchemaCompareDetail = Infer<typeof detailSchema>;
export type SchemaCompareChange = Infer<typeof changeSchema>;
