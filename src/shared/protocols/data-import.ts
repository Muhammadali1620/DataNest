// The data import page (V5.3): the page picks how the file is read and which column
// gets which field; the host reads the file, converts values and runs the import.

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
  union,
} from '../schema';

const NAME = 1000;
/** Rows the page shows from the start of the file. */
export const SAMPLE_ROWS = 20;

export const IMPORT_DELIMITERS = [',', ';', '\t', '|'] as const;

export const importOptionsSchema = object({
  format: literal('csv', 'json'),
  delimiter: literal(...IMPORT_DELIMITERS),
  /** CSV: the first record holds the column names. */
  header: boolean(),
  /** CSV: an empty field is NULL. */
  emptyIsNull: boolean(),
  /** CSV: text that stands for NULL, e.g. `\N`; empty for none. */
  nullText: string({ maxLength: 100 }),
});

/** For each column of the table: the index of the file's column it is filled from, or null. */
const mappingSchema = array(nullable(number({ integer: true, min: 0, max: 100_000 })), {
  maxLength: 10_000,
});

const targetColumnSchema = object({
  name: string({ maxLength: NAME }),
  dataType: string({ maxLength: NAME }),
  nullable: boolean(),
  /** Leaving it out lets the database fill it: a default, NULL or a generated value. */
  hasDefault: boolean(),
  autoIncrement: boolean(),
  /** Computed by the database: it cannot be imported into. */
  generated: boolean(),
});

const sourceSchema = object({
  columns: array(string({ maxLength: NAME }), { maxLength: 10_000 }),
  /** The first records as the file has them; an unreadable one carries its error. */
  rows: array(
    object({
      line: number({ integer: true, min: 0 }),
      cells: array(nullable(string({ maxLength: 10_000 })), { maxLength: 10_000 }),
      error: optional(string({ maxLength: 2000 })),
    }),
    { maxLength: SAMPLE_ROWS },
  ),
});

const previewCellSchema = union(
  object({ text: string({ maxLength: 10_000 }) }),
  object({ problem: string({ maxLength: 100 }) }),
  object({ fill: literal('default') }),
);

const progressSchema = object({
  read: number({ integer: true, min: 0 }),
  inserted: number({ integer: true, min: 0 }),
  failed: number({ integer: true, min: 0 }),
  /** Part of the file read, 0…100. */
  percent: number({ min: 0, max: 100 }),
});

const failureSchema = object({
  line: number({ integer: true, min: 0 }),
  lastLine: optional(number({ integer: true, min: 0 })),
  column: optional(string({ maxLength: NAME })),
  problem: optional(string({ maxLength: 100 })),
  message: optional(string({ maxLength: 4000 })),
});

const reportSchema = object({
  outcome: literal('done', 'stopped', 'cancelled'),
  read: number({ integer: true, min: 0 }),
  inserted: number({ integer: true, min: 0 }),
  failedCount: number({ integer: true, min: 0 }),
  failures: array(failureSchema, { maxLength: 1000 }),
  rolledBack: boolean(),
  durationMs: number({ min: 0 }),
});

const stateSchema = object({
  driver: literal(...DRIVER_IDS),
  /** False where a stopped import cannot be undone (ClickHouse has no transactions). */
  transactional: boolean(),
  /** The table, as the title shows it: `shop.orders`. */
  table: string({ maxLength: NAME }),
  file: string({ maxLength: 4000 }),
  size: number({ min: 0 }),
  columns: array(targetColumnSchema, { maxLength: 10_000 }),
  options: importOptionsSchema,
  source: sourceSchema,
  mapping: mappingSchema,
  /** Set while an import runs, so a reloaded page shows its progress. */
  progress: optional(progressSchema),
  report: optional(reportSchema),
});

const runSchema = object({
  options: importOptionsSchema,
  mapping: mappingSchema,
  mode: literal('all', 'skip'),
});

export const dataImportProtocol = defineProtocol({
  host: {
    requests: {
      /** Reads the start of the file again with other options. */
      load: {
        params: importOptionsSchema,
        result: object({ source: sourceSchema, mapping: mappingSchema }),
      },
      /** The first rows as they would go into the table. */
      preview: {
        params: object({ options: importOptionsSchema, mapping: mappingSchema }),
        result: object({
          rows: array(
            object({
              line: number({ integer: true, min: 0 }),
              cells: array(previewCellSchema, { maxLength: 10_000 }),
              error: optional(string({ maxLength: 2000 })),
            }),
            { maxLength: SAMPLE_ROWS },
          ),
        }),
      },
      /** Starts the import after the host's own checks and questions. */
      start: { params: runSchema, result: object({ started: boolean() }) },
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
      progress: progressSchema,
      finished: reportSchema,
    },
  },
});

export type DataImportProtocol = typeof dataImportProtocol;
export type ImportOptions = Infer<typeof importOptionsSchema>;
export type ImportMapping = Infer<typeof mappingSchema>;
export type ImportTargetColumn = Infer<typeof targetColumnSchema>;
export type ImportSourceView = Infer<typeof sourceSchema>;
export type ImportPageState = Infer<typeof stateSchema>;
export type ImportPreviewRow = Infer<
  typeof dataImportProtocol.host.requests.preview.result
>['rows'][number];
export type ImportPageProgress = Infer<typeof progressSchema>;
export type ImportPageReport = Infer<typeof reportSchema>;
