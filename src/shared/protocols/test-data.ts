// The test data page (V5.5): the page chooses a generator and a NULL share per
// column, a row count and a seed; the host previews, inserts or writes the SQL.

import { DRIVER_IDS } from '../connection';
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
/** Rows the page previews. */
export const PREVIEW_ROWS = 10;
/** Most rows one run inserts. */
export const MAX_GENERATED_ROWS = 1_000_000;
/** Most rows written as SQL into an editor. */
export const MAX_SCRIPT_ROWS = 10_000;

/** Kept in step with GENERATOR_KINDS of services/test-data/generators.ts (a test checks). */
export const GENERATOR_IDS = [
  'default',
  'null',
  'sequence',
  'integer',
  'decimal',
  'boolean',
  'date',
  'datetime',
  'time',
  'uuid',
  'text',
  'words',
  'sentence',
  'firstName',
  'lastName',
  'fullName',
  'username',
  'email',
  'phone',
  'company',
  'city',
  'country',
  'countryCode',
  'address',
  'postalCode',
  'url',
  'ip',
  'latitude',
  'longitude',
  'price',
  'color',
  'currency',
  'status',
  'enum',
  'json',
  'binary',
  'reference',
] as const;

const choiceSchema = object({
  generator: literal(...GENERATOR_IDS),
  nullPercent: number({ integer: true, min: 0, max: 100 }),
});

const columnSchema = object({
  name: string({ maxLength: NAME }),
  dataType: string({ maxLength: NAME }),
  nullable: boolean(),
  /** The database fills it: auto-numbered or computed. */
  locked: optional(literal('auto', 'generated')),
  unique: boolean(),
  /** `table.column` a one-column foreign key points at. */
  reference: optional(string({ maxLength: NAME * 2 })),
});

const choicesSchema = array(choiceSchema, { maxLength: 10_000 });
const seedSchema = number({ integer: true, min: 0, max: 0xffffffff });
const countSchema = number({ integer: true, min: 1, max: MAX_GENERATED_ROWS });

const reportSchema = object({
  outcome: literal('done', 'stopped', 'cancelled'),
  inserted: number({ integer: true, min: 0 }),
  /** Why it stopped: the server's message, or a value that did not fit. */
  message: optional(string({ maxLength: 4000 })),
  durationMs: number({ min: 0 }),
});

const stateSchema = object({
  driver: literal(...DRIVER_IDS),
  table: string({ maxLength: NAME }),
  columns: array(columnSchema, { maxLength: 10_000 }),
  choices: choicesSchema,
  count: countSchema,
  seed: seedSchema,
  progress: optional(object({ done: number({ min: 0 }), total: number({ min: 0 }) })),
  report: optional(reportSchema),
});

const runSchema = object({ choices: choicesSchema, count: countSchema, seed: seedSchema });

export const testDataProtocol = defineProtocol({
  host: {
    requests: {
      /** The first rows these choices give. */
      preview: {
        params: object({ choices: choicesSchema, seed: seedSchema }),
        result: object({
          rows: array(array(nullable(string({ maxLength: 10_000 })), { maxLength: 10_000 }), {
            maxLength: PREVIEW_ROWS,
          }),
          /** Why a column cannot be filled as chosen, by column name. */
          problems: array(object({ column: string({ maxLength: NAME }), problem: string() }), {
            maxLength: 10_000,
          }),
        }),
      },
      /** Inserts the rows after the host's own checks. */
      insert: { params: runSchema, result: object({ started: boolean() }) },
      /** Opens the rows as INSERT statements in a new editor. */
      openSql: { params: runSchema, result: object({ opened: boolean() }) },
    },
    events: {
      ready: object({}),
      cancel: object({}),
      close: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      state: stateSchema,
      progress: object({ done: number({ min: 0 }), total: number({ min: 0 }) }),
      finished: reportSchema,
    },
  },
});

export type TestDataProtocol = typeof testDataProtocol;
export type TestDataState = Infer<typeof stateSchema>;
export type TestDataChoice = Infer<typeof choiceSchema>;
export type TestDataColumn = Infer<typeof columnSchema>;
export type TestDataReport = Infer<typeof reportSchema>;
export type GeneratorId = (typeof GENERATOR_IDS)[number];
