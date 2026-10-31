// The table designer page: it edits a TableDesign and asks the host for the SQL;
// the host builds every statement and runs it only after the user confirms.

import { DRIVER_IDS } from '../connection';
import { defineProtocol } from '../rpc';
import { tableBarSchema, tableNavSchema } from '../table-actions';
import {
  array,
  boolean,
  type Infer,
  literal,
  object,
  optional,
  type Schema,
  string,
} from '../schema';
import {
  type ColumnDesign,
  DESIGN_LIMITS,
  type ForeignKeyDesign,
  type IndexDesign,
  REFERENTIAL_ACTIONS,
  type TableDesign,
} from '../table-design';

const ID_LENGTH = 100;

/** The tabs of the table page; the DDL, triggers and checks ones exist for stored tables only. */
export const TABLE_TABS = [
  'ddl',
  'columns',
  'indexes',
  'keys',
  'triggers',
  'checks',
  'sql',
] as const;
export type TableTab = (typeof TABLE_TABS)[number];

export const columnDesignSchema: Schema<ColumnDesign> = object({
  id: string({ minLength: 1, maxLength: ID_LENGTH }),
  original: optional(string({ maxLength: DESIGN_LIMITS.name })),
  name: string({ maxLength: DESIGN_LIMITS.name }),
  type: string({ maxLength: DESIGN_LIMITS.type }),
  length: string({ maxLength: DESIGN_LIMITS.length }),
  nullable: boolean(),
  defaultValue: string({ maxLength: DESIGN_LIMITS.defaultValue }),
  autoIncrement: boolean(),
  primaryKey: boolean(),
  comment: string({ maxLength: DESIGN_LIMITS.comment }),
});

const idSchema = string({ minLength: 1, maxLength: ID_LENGTH });
const columnIdsSchema = array(idSchema, { maxLength: DESIGN_LIMITS.columns });

export const indexDesignSchema: Schema<IndexDesign> = object({
  id: idSchema,
  original: optional(string({ maxLength: DESIGN_LIMITS.name })),
  name: string({ maxLength: DESIGN_LIMITS.name }),
  columns: columnIdsSchema,
  unique: boolean(),
});

export const foreignKeyDesignSchema: Schema<ForeignKeyDesign> = object({
  id: idSchema,
  original: optional(string({ maxLength: DESIGN_LIMITS.name })),
  name: string({ maxLength: DESIGN_LIMITS.name }),
  columns: columnIdsSchema,
  targetSchema: optional(string({ maxLength: DESIGN_LIMITS.name })),
  targetTable: string({ maxLength: DESIGN_LIMITS.name }),
  targetColumns: array(string({ maxLength: DESIGN_LIMITS.name }), {
    maxLength: DESIGN_LIMITS.columns,
  }),
  onDelete: literal(...REFERENTIAL_ACTIONS),
  onUpdate: literal(...REFERENTIAL_ACTIONS),
});

export const tableDesignSchema: Schema<TableDesign> = object({
  name: string({ maxLength: DESIGN_LIMITS.name }),
  comment: string({ maxLength: DESIGN_LIMITS.comment }),
  columns: array(columnDesignSchema, { maxLength: DESIGN_LIMITS.columns }),
  indexes: array(indexDesignSchema, { maxLength: DESIGN_LIMITS.indexes }),
  foreignKeys: array(foreignKeyDesignSchema, { maxLength: DESIGN_LIMITS.foreignKeys }),
});

const namesSchema = array(string({ maxLength: DESIGN_LIMITS.name }), { maxLength: 100_000 });

const keptSchema = object({
  /** Indexes the designer cannot express, with a short description of each. */
  indexes: array(
    object({
      name: string({ maxLength: DESIGN_LIMITS.name }),
      description: string({ maxLength: 4000 }),
    }),
    { maxLength: 1000 },
  ),
  /** Computed columns, shown but never changed. */
  columns: array(string({ maxLength: DESIGN_LIMITS.name }), { maxLength: DESIGN_LIMITS.columns }),
});

const checkSchema = object({
  name: string({ maxLength: DESIGN_LIMITS.name }),
  expression: string({ maxLength: 20_000 }),
});

const actionOutcomeSchema = literal('ran', 'opened', 'cancelled', 'unsupported');

const stateSchema = object({
  /** The bar of the table's pages; absent while designing a new table. */
  tableBar: optional(tableBarSchema),
  /** `create` for a new table; `edit` for an existing one, whose design is as stored. */
  mode: literal('create', 'edit'),
  driver: literal(...DRIVER_IDS),
  /** Where the table lives, shown in the title: `shop`, `shop.public`. */
  scope: string({ maxLength: 1000 }),
  features: object({
    columnComments: boolean(),
    tableComment: boolean(),
    types: array(string({ maxLength: DESIGN_LIMITS.type }), { maxLength: 500 }),
    reorder: boolean(),
    autoIncrement: boolean(),
    foreignKeys: boolean(),
    uniqueIndexes: boolean(),
    /** Triggers of the table can be listed, created and dropped here. */
    triggers: boolean(),
    /** CHECK constraints can be listed, added and dropped here. */
    checks: boolean(),
  }),
  /** The tab to show first; the columns when absent. */
  tab: optional(literal(...TABLE_TABS)),
  design: tableDesignSchema,
  kept: keptSchema,
});

const previewSchema = object({
  statements: array(string(), { maxLength: 10_000 }),
  /** Things worth knowing before running the statements. */
  notes: array(literal('order-ignored', 'rebuild'), { maxLength: 10 }),
  /** Why no SQL could be built, e.g. a database that cannot do this. */
  error: optional(string({ maxLength: 2000 })),
});

export const tableDesignerProtocol = defineProtocol({
  host: {
    requests: {
      /** The SQL that saving this design would run. */
      preview: { params: tableDesignSchema, result: previewSchema },
      /** Tables a foreign key can point at: those of the designed table's scope. */
      tables: { params: object({}), result: object({ tables: namesSchema }) },
      /** Columns of one table of the scope, for the referenced columns of a key. */
      columns: {
        params: object({ table: string({ minLength: 1, maxLength: DESIGN_LIMITS.name }) }),
        result: object({ columns: namesSchema }),
      },
      /** Shows the SQL in a dialog and runs it if the user agrees. */
      save: {
        params: tableDesignSchema,
        result: object({
          outcome: literal('ran', 'opened', 'cancelled', 'unsupported', 'invalid', 'unchanged'),
        }),
      },
      /** The CREATE statements of the stored table, as text. */
      definition: {
        params: object({}),
        result: object({ text: string({ maxLength: 5_000_000 }) }),
      },
      /** Names of the triggers of the stored table. */
      triggers: {
        params: object({}),
        result: object({ triggers: namesSchema }),
      },
      /** View, edit, drop a trigger, or start a new one from a template. */
      triggerAction: {
        params: object({
          action: literal('view', 'edit', 'drop', 'new'),
          name: optional(string({ maxLength: DESIGN_LIMITS.name })),
        }),
        result: object({ outcome: actionOutcomeSchema }),
      },
      /** CHECK constraints of the stored table. */
      checks: {
        params: object({}),
        result: object({ checks: array(checkSchema, { maxLength: 10_000 }) }),
      },
      /** Adds or drops a CHECK after showing the SQL; `error` when the input is not valid. */
      checkAction: {
        params: object({
          action: literal('add', 'drop'),
          name: string({ maxLength: DESIGN_LIMITS.name }),
          expression: optional(string({ maxLength: 20_000 })),
        }),
        result: object({
          outcome: actionOutcomeSchema,
          error: optional(string({ maxLength: 2000 })),
        }),
      },
      /**
       * Moves a stored column one place where the database cannot do it in place: a
       * script that rebuilds the table is opened for review (D116).
       */
      moveColumn: {
        params: object({
          column: string({ maxLength: DESIGN_LIMITS.name }),
          direction: literal('up', 'down'),
        }),
        result: object({ outcome: actionOutcomeSchema }),
      },
      /** Copies text to the clipboard or opens it in a SQL editor. */
      textAction: {
        params: object({
          action: literal('copy', 'open'),
          text: string({ maxLength: 5_000_000 }),
        }),
        result: object({}),
      },
    },
    events: {
      ready: object({}),
      close: object({}),
      /** The bar of the table was pressed: go to another page of the table. */
      tableNav: tableNavSchema,
    },
  },
  webview: {
    requests: {},
    events: {
      /** Host → page: everything to render, on every load (D21). */
      state: stateSchema,
      /** Host → page: show this tab (the page is already open). */
      tab: object({ tab: literal(...TABLE_TABS) }),
    },
  },
});

export type TableDesignerProtocol = typeof tableDesignerProtocol;
export type TableDesignerState = Infer<typeof stateSchema>;
export type DesignPreview = Infer<typeof previewSchema>;
export type SaveOutcome = Infer<typeof tableDesignerProtocol.host.requests.save.result>;
