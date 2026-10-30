// The server monitor page (V8.5): the host reads the server's sessions, settings and
// status whenever the page asks, and stops a session's statement after asking the user.

import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, literal, number, object, optional, string } from '../schema';

const NAME = 1000;
const TEXT = 100_000;
/** More rows than any server lists: ClickHouse's metrics and settings run to a few thousand. */
const ROWS = 50_000;

const processSchema = object({
  id: string({ maxLength: NAME }),
  user: optional(string({ maxLength: NAME })),
  host: optional(string({ maxLength: NAME })),
  database: optional(string({ maxLength: NAME })),
  application: optional(string({ maxLength: NAME })),
  state: optional(string({ maxLength: NAME })),
  seconds: optional(number({ min: 0 })),
  query: optional(string({ maxLength: TEXT })),
  idle: boolean(),
  mine: boolean(),
  blockedBy: optional(string({ maxLength: NAME })),
});

const settingSchema = object({
  name: string({ maxLength: NAME }),
  value: string({ maxLength: TEXT }),
  unit: optional(string({ maxLength: NAME })),
  description: optional(string({ maxLength: TEXT })),
  changed: optional(boolean()),
});

const statusSchema = object({
  name: string({ maxLength: NAME }),
  value: string({ maxLength: TEXT }),
  group: optional(string({ maxLength: NAME })),
  /** The change per second since the previous reading, for numbers that changed. */
  perSecond: optional(number()),
});

const summarySchema = object({
  version: optional(string({ maxLength: NAME })),
  uptimeSeconds: optional(number({ min: 0 })),
  connections: optional(number({ min: 0 })),
  maxConnections: optional(number({ min: 0 })),
  sizeBytes: optional(number({ min: 0 })),
  /** Queries or transactions per second since the previous reading. */
  rate: optional(
    object({ kind: literal('queries', 'transactions'), perSecond: number({ min: 0 }) }),
  ),
});

export const SETTING_SCOPES = ['session', 'server'] as const;

const stateSchema = object({
  connectionName: string({ maxLength: NAME }),
  /** `PostgreSQL`, `MariaDB`, …: the server, once the host knows it. */
  server: optional(string({ maxLength: NAME })),
  features: optional(
    object({
      processes: boolean(),
      cancel: boolean(),
      terminate: boolean(),
      scopes: array(literal(...SETTING_SCOPES), { maxLength: 2 }),
      serverScope: literal('global', 'cluster', 'server', 'system'),
    }),
  ),
  /** The connection refuses changes, so nothing can be stopped from here. */
  readOnly: boolean(),
  error: optional(string({ maxLength: TEXT })),
});

const readingSchema = { at: number({ integer: true, min: 0 }) };

export const serverMonitorProtocol = defineProtocol({
  host: {
    requests: {
      processes: {
        params: object({}),
        result: object({ rows: array(processSchema, { maxLength: ROWS }), ...readingSchema }),
      },
      settings: {
        params: object({ scope: literal(...SETTING_SCOPES) }),
        result: object({ rows: array(settingSchema, { maxLength: ROWS }) }),
      },
      status: {
        params: object({}),
        result: object({
          rows: array(statusSchema, { maxLength: ROWS }),
          summary: summarySchema,
          ...readingSchema,
        }),
      },
      /** Asks the user, then stops the statement or the session; false when declined. */
      stop: {
        params: object({ id: string({ maxLength: NAME }), kind: literal('cancel', 'terminate') }),
        result: object({ stopped: boolean() }),
      },
    },
    events: {
      ready: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      state: stateSchema,
    },
  },
});

export type ServerMonitorProtocol = typeof serverMonitorProtocol;
export type ServerMonitorState = Infer<typeof stateSchema>;
export type MonitorProcess = Infer<typeof processSchema>;
export type MonitorSetting = Infer<typeof settingSchema>;
export type MonitorStatusRow = Infer<typeof statusSchema>;
export type MonitorSummary = Infer<typeof summarySchema>;
export type MonitorScope = (typeof SETTING_SCOPES)[number];
