// The Redis console (V7.4): the page sends lines, the host runs them one by one and
// sends each result back as it comes; the page suggests commands from the catalog the
// server documents, and key names it asks the host for.

import { REDIS_MODES } from '../connection';
import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, literal, number, object, optional, string } from '../schema';

/** Lines of output one command may show; a bigger reply says how much was left out. */
export const MAX_OUTPUT_LINES = 5000;
/** Lines the console remembers per connection, for the arrow keys. */
export const MAX_HISTORY = 500;

const commandDocSchema = object({
  name: string({ maxLength: 200 }),
  summary: optional(string({ maxLength: 5000 })),
  syntax: optional(string({ maxLength: 10_000 })),
  group: optional(string({ maxLength: 100 })),
  since: optional(string({ maxLength: 50 })),
  keyFirst: boolean(),
});

const consoleStateSchema = object({
  connectionName: string({ maxLength: 500 }),
  database: number({ integer: true, min: 0 }),
  mode: literal(...REDIS_MODES),
  readOnly: boolean(),
  production: boolean(),
  /** What the server documents; empty when it may not be asked. */
  commands: array(commandDocSchema, { maxLength: 20_000 }),
  history: array(string({ maxLength: 100_000 }), { maxLength: MAX_HISTORY }),
});

const outputSchema = object({
  command: string({ maxLength: 100_000 }),
  lines: array(string({ maxLength: 2_000_000 }), { maxLength: MAX_OUTPUT_LINES + 1 }),
  error: boolean(),
  ms: optional(number({ min: 0 })),
});

export const redisConsoleProtocol = defineProtocol({
  host: {
    requests: {
      /** Runs every line of the text in turn; results arrive as `output` events. */
      run: { params: object({ text: string({ maxLength: 1_000_000 }) }), result: object({}) },
      /** Key names that start with the prefix. */
      completeKeys: {
        params: object({ prefix: string({ maxLength: 10_000 }) }),
        result: object({ keys: array(string({ maxLength: 100_000 }), { maxLength: 200 }) }),
      },
      /** Drops the console's connection, which also ends a command that blocks. */
      stop: { params: object({}), result: object({}) },
    },
    events: {
      ready: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      state: consoleStateSchema,
      output: outputSchema,
      /** A SELECT moved the console to another database. */
      database: object({ database: number({ integer: true, min: 0 }) }),
    },
  },
});

export type RedisConsoleProtocol = typeof redisConsoleProtocol;
export type RedisConsoleState = Infer<typeof consoleStateSchema>;
export type ConsoleOutput = Infer<typeof outputSchema>;
export type ConsoleCommandDoc = Infer<typeof commandDocSchema>;
