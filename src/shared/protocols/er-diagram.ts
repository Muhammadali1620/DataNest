// The ER diagram page (V8.1): the host reads tables and keys, the page lays them out,
// draws them and hands back pictures to save. Positions live in the host, so a
// reloaded page (D21) shows the boxes where the user left them.

import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, literal, number, object, optional, string } from '../schema';

const NAME = 1000;
const MAX_TABLES = 5000;
const MAX_COLUMNS = 5000;
/** A PNG of a big diagram at twice the scale is still well under this. */
const MAX_PICTURE = 96_000_000;

const columnSchema = object({
  name: string({ maxLength: NAME }),
  dataType: string({ maxLength: NAME }),
  nullable: boolean(),
  primaryKey: boolean(),
  foreignKey: boolean(),
});

const tableSchema = object({
  id: string({ maxLength: NAME * 4 }),
  label: string({ maxLength: NAME * 3 }),
  columns: array(columnSchema, { maxLength: MAX_COLUMNS }),
  external: optional(literal(true)),
});

const relationSchema = object({
  name: string({ maxLength: NAME }),
  from: string({ maxLength: NAME * 4 }),
  columns: array(string({ maxLength: NAME }), { maxLength: MAX_COLUMNS }),
  to: string({ maxLength: NAME * 4 }),
  targetColumns: array(string({ maxLength: NAME }), { maxLength: MAX_COLUMNS }),
  optional: boolean(),
});

const positionSchema = object({
  id: string({ maxLength: NAME * 4 }),
  x: number({ min: -10_000_000, max: 10_000_000 }),
  y: number({ min: -10_000_000, max: 10_000_000 }),
});

/** What every box lists: all columns, only key columns, or just the table name. */
export const ER_DETAILS = ['all', 'keys', 'names'] as const;

const stateSchema = object({
  /** `shop` or `shop.public`, for the heading and file names. */
  scope: string({ maxLength: NAME * 2 }),
  connection: string({ maxLength: NAME }),
  tables: array(tableSchema, { maxLength: MAX_TABLES * 2 }),
  relations: array(relationSchema, { maxLength: MAX_TABLES * 20 }),
  /** Empty: the page lays the boxes out itself and reports where. */
  positions: array(positionSchema, { maxLength: MAX_TABLES * 2 }),
  details: literal(...ER_DETAILS),
});

const progressSchema = object({
  done: number({ integer: true, min: 0 }),
  total: number({ integer: true, min: 0 }),
});

export const erDiagramProtocol = defineProtocol({
  host: {
    requests: {
      /** Saves a picture of the diagram to a file the user picks. */
      save: {
        params: object({
          format: literal('svg', 'png'),
          /** SVG text, or a PNG as base64. */
          data: string({ maxLength: MAX_PICTURE }),
        }),
        result: object({ saved: boolean() }),
      },
    },
    events: {
      ready: object({}),
      /** Where the boxes are now, after a layout or a drag. */
      positions: object({ positions: array(positionSchema, { maxLength: MAX_TABLES * 2 }) }),
      details: object({ details: literal(...ER_DETAILS) }),
      /** Reads the tables again. */
      refresh: object({}),
      /** Opens the rows of a table of the scope. */
      openTable: object({ id: string({ maxLength: NAME * 4 }) }),
    },
  },
  webview: {
    requests: {},
    events: {
      /** Reading the tables: how far it got. */
      loading: progressSchema,
      state: stateSchema,
      /** Reading failed; the message says why. */
      failed: object({ message: string({ maxLength: 4000 }) }),
    },
  },
});

export type ErDiagramProtocol = typeof erDiagramProtocol;
export type ErDiagramState = Infer<typeof stateSchema>;
export type ErDiagramTable = Infer<typeof tableSchema>;
export type ErDiagramRelation = Infer<typeof relationSchema>;
export type ErPosition = Infer<typeof positionSchema>;
export type ErDetails = (typeof ER_DETAILS)[number];
