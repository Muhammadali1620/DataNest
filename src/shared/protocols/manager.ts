// The Manager page (V11.13): one page per connection with a section list on the left.
// Dashboard, ProcessList and Structure Sync reuse the server monitor and the schema
// comparison pages as they are: their protocols ride on this one under the prefixes
// `monitor.` and `compare.`, so the same components work in both places.

import { defineProtocol, type SideSpec } from '../rpc';
import { array, boolean, type Infer, literal, number, object, optional, string } from '../schema';
import { tableNavSchema } from '../table-actions';
import { schemaCompareProtocol } from './schema-compare';
import { serverMonitorProtocol } from './server-monitor';

const NAME = 1000;
const TEXT = 100_000;
const ITEMS = 100_000;

export const MANAGER_SECTIONS = ['log', 'dashboard', 'processes', 'dump', 'sync'] as const;
export type ManagerSection = (typeof MANAGER_SECTIONS)[number];

type Prefixed<S, P extends string> = { [K in keyof S & string as `${P}.${K}`]: S[K] };

/** The same side of a protocol with every request and event name under `prefix.`. */
export function prefixSide<S extends SideSpec, const P extends string>(
  side: S,
  prefix: P,
): { requests: Prefixed<S['requests'], P>; events: Prefixed<S['events'], P> } {
  const rename = (record: Readonly<Record<string, unknown>>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(record).map(([key, value]) => [`${prefix}.${key}`, value]));
  return {
    requests: rename(side.requests) as Prefixed<S['requests'], P>,
    events: rename(side.events) as Prefixed<S['events'], P>,
  };
}

const monitorHost = prefixSide(serverMonitorProtocol.host, 'monitor');
const monitorWebview = prefixSide(serverMonitorProtocol.webview, 'monitor');
const compareHost = prefixSide(schemaCompareProtocol.host, 'compare');
const compareWebview = prefixSide(schemaCompareProtocol.webview, 'compare');

const logEntrySchema = object({
  id: string({ maxLength: NAME }),
  at: number({ min: 0 }),
  sql: string({ maxLength: TEXT }),
  ok: boolean(),
  durationMs: number({ min: 0 }),
  rows: optional(number({ integer: true, min: 0 })),
  affected: optional(number({ integer: true, min: 0 })),
  error: optional(string({ maxLength: TEXT })),
  database: optional(string({ maxLength: NAME })),
  runs: number({ integer: true, min: 1 }),
});

const relationSchema = object({
  name: string({ maxLength: NAME }),
  kind: literal('table', 'view'),
});

export const DUMP_CONTENTS = ['all', 'structure', 'data'] as const;

const scopeSchema = object({
  connectionId: string({ maxLength: NAME }),
  database: optional(string({ maxLength: NAME })),
  schema: optional(string({ maxLength: NAME })),
});

const stateSchema = object({
  connectionId: string({ maxLength: NAME }),
  connectionName: string({ maxLength: NAME }),
  /** The product behind the connection, as the dialect names it. */
  driver: string({ maxLength: NAME }),
  /** The sections this connection supports, in the order of the list. */
  sections: array(literal(...MANAGER_SECTIONS), { maxLength: MANAGER_SECTIONS.length }),
  section: literal(...MANAGER_SECTIONS),
  database: optional(string({ maxLength: NAME })),
  schema: optional(string({ maxLength: NAME })),
  /** The table the page was opened from, for the bar of table pages. */
  table: optional(object({ name: string({ maxLength: NAME }), kind: literal('table', 'view') })),
  readOnly: boolean(),
  production: boolean(),
});

const dumpOptionsSchema = object({
  /** Databases to pick from; empty where the connection is a single database. */
  databases: array(string({ maxLength: NAME }), { maxLength: ITEMS }),
  database: optional(string({ maxLength: NAME })),
  /** Schemas of the database; empty where there are none. */
  schemas: array(string({ maxLength: NAME }), { maxLength: ITEMS }),
  schema: optional(string({ maxLength: NAME })),
  relations: array(relationSchema, { maxLength: ITEMS }),
  /** The tables ticked at first: the one the page was opened from, else all. */
  ticked: array(string({ maxLength: NAME }), { maxLength: ITEMS }),
  /** The path with `{data_source}` and `{timestamp}` still in it. */
  output: string({ maxLength: 4000 }),
});

const dumpReportSchema = object({
  path: string({ maxLength: 4000 }),
  bytes: number({ min: 0 }),
  tables: number({ integer: true, min: 0 }),
  views: number({ integer: true, min: 0 }),
  objects: number({ integer: true, min: 0 }),
  rows: number({ integer: true, min: 0 }),
  durationMs: number({ min: 0 }),
  skipped: array(string({ maxLength: NAME }), { maxLength: ITEMS }),
});

const syncConnectionSchema = object({
  id: string({ maxLength: NAME }),
  name: string({ maxLength: NAME }),
  detail: string({ maxLength: NAME * 2 }),
});

export const managerProtocol = defineProtocol({
  host: {
    requests: {
      ...monitorHost.requests,
      ...compareHost.requests,
      'log.list': {
        params: object({}),
        result: object({ entries: array(logEntrySchema, { maxLength: ITEMS }) }),
      },
      /** Asks first; the statements of this connection are forgotten. */
      'log.clear': { params: object({}), result: object({ cleared: boolean() }) },
      'dump.options': {
        params: object({
          database: optional(string({ maxLength: NAME })),
          schema: optional(string({ maxLength: NAME })),
        }),
        result: dumpOptionsSchema,
      },
      /** The save dialog, for the folder and the file name of the dump. */
      'dump.browse': {
        params: object({ output: string({ maxLength: 4000 }) }),
        result: object({ output: optional(string({ maxLength: 4000 })) }),
      },
      'dump.run': {
        params: object({
          database: optional(string({ maxLength: NAME })),
          schema: optional(string({ maxLength: NAME })),
          /** Names of the ticked tables and views. */
          relations: array(string({ maxLength: NAME }), { maxLength: ITEMS }),
          /** The routines, events, sequences and types of the scope go along. */
          wholeScope: boolean(),
          content: literal(...DUMP_CONTENTS),
          dropFirst: boolean(),
          output: string({ minLength: 1, maxLength: 4000 }),
        }),
        result: dumpReportSchema,
      },
      'dump.reveal': {
        params: object({ path: string({ maxLength: 4000 }), how: literal('open', 'folder') }),
        result: object({ done: boolean() }),
      },
      'sync.options': {
        params: object({}),
        result: object({ connections: array(syncConnectionSchema, { maxLength: ITEMS }) }),
      },
      'sync.scopes': {
        params: object({
          connectionId: string({ maxLength: NAME }),
          database: optional(string({ maxLength: NAME })),
        }),
        result: object({
          databases: array(string({ maxLength: NAME }), { maxLength: ITEMS }),
          schemas: array(string({ maxLength: NAME }), { maxLength: ITEMS }),
        }),
      },
      /** Reads both schemas and starts the comparison; the compare.* events follow. */
      'sync.start': {
        params: object({ source: scopeSchema, target: scopeSchema }),
        result: object({ started: boolean() }),
      },
    },
    events: {
      ...monitorHost.events,
      ...compareHost.events,
      ready: object({}),
      /** A button of the table bar was pressed: the page is left for another page of the table. */
      tableNav: tableNavSchema,
      'dump.cancel': object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      ...monitorWebview.events,
      ...compareWebview.events,
      state: stateSchema,
      /** The statements of the connection changed: the log reads them again. */
      'log.changed': object({}),
      'dump.progress': object({
        table: optional(string({ maxLength: NAME })),
        rows: number({ integer: true, min: 0 }),
        tablesDone: number({ integer: true, min: 0 }),
        tablesTotal: number({ integer: true, min: 0 }),
      }),
    },
  },
});

export type ManagerProtocol = typeof managerProtocol;
export type ManagerState = Infer<typeof stateSchema>;
export type ManagerLogEntry = Infer<typeof logEntrySchema>;
export type ManagerDumpOptions = Infer<typeof dumpOptionsSchema>;
export type ManagerDumpReport = Infer<typeof dumpReportSchema>;
export type ManagerSyncConnection = Infer<typeof syncConnectionSchema>;
export type ManagerScope = Infer<typeof scopeSchema>;
