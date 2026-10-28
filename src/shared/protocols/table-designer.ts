// The table designer page: it edits a TableDesign and asks the host for the SQL;
// the host builds every statement and runs it only after the user confirms.

import { DRIVER_IDS } from '../connection';
import { defineProtocol } from '../rpc';
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
import { type ColumnDesign, DESIGN_LIMITS, type TableDesign } from '../table-design';

const ID_LENGTH = 100;

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

export const tableDesignSchema: Schema<TableDesign> = object({
  name: string({ maxLength: DESIGN_LIMITS.name }),
  comment: string({ maxLength: DESIGN_LIMITS.comment }),
  columns: array(columnDesignSchema, { maxLength: DESIGN_LIMITS.columns }),
});

const stateSchema = object({
  mode: literal('create', 'edit'),
  driver: literal(...DRIVER_IDS),
  /** Where the table lives, shown in the title: `shop`, `shop.public`. */
  scope: string({ maxLength: 1000 }),
  features: object({
    columnComments: boolean(),
    tableComment: boolean(),
    types: array(string({ maxLength: DESIGN_LIMITS.type }), { maxLength: 500 }),
  }),
  design: tableDesignSchema,
});

const previewSchema = object({
  statements: array(string(), { maxLength: 10_000 }),
  /** Why no SQL could be built, e.g. a database that cannot do this. */
  error: optional(string({ maxLength: 2000 })),
});

export const tableDesignerProtocol = defineProtocol({
  host: {
    requests: {
      /** The SQL that saving this design would run. */
      preview: { params: tableDesignSchema, result: previewSchema },
      /** Shows the SQL in a dialog and runs it if the user agrees. */
      save: {
        params: tableDesignSchema,
        result: object({
          outcome: literal('ran', 'opened', 'cancelled', 'unsupported', 'invalid'),
        }),
      },
    },
    events: {
      ready: object({}),
      close: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      /** Host → page: everything to render, on every load (D21). */
      state: stateSchema,
    },
  },
});

export type TableDesignerProtocol = typeof tableDesignerProtocol;
export type TableDesignerState = Infer<typeof stateSchema>;
export type DesignPreview = Infer<typeof previewSchema>;
export type SaveOutcome = Infer<typeof tableDesignerProtocol.host.requests.save.result>;
