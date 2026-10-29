// Redis server information (V7.4): the host reads INFO from the server, or from every
// master of a cluster, and the page shows the main numbers and every field by section.

import { defineProtocol } from '../rpc';
import { array, type Infer, number, object, optional, string } from '../schema';

const summarySchema = object({
  version: optional(string({ maxLength: 100 })),
  mode: optional(string({ maxLength: 100 })),
  role: optional(string({ maxLength: 100 })),
  uptimeSeconds: optional(number({ min: 0 })),
  clients: optional(number({ min: 0 })),
  usedMemory: optional(number({ min: 0 })),
  peakMemory: optional(number({ min: 0 })),
  maxMemory: optional(number({ min: 0 })),
  opsPerSecond: optional(number({ min: 0 })),
  hitRate: optional(number({ min: 0, max: 1 })),
  keys: number({ min: 0 }),
});

const nodeSchema = object({
  /** The server, or `master 2` of a cluster. */
  name: string({ maxLength: 500 }),
  sections: array(
    object({
      name: string({ maxLength: 200 }),
      fields: array(array(string({ maxLength: 100_000 }), { maxLength: 2 }), {
        maxLength: 10_000,
      }),
    }),
    { maxLength: 200 },
  ),
  summary: summarySchema,
});

const infoStateSchema = object({
  connectionName: string({ maxLength: 500 }),
  nodes: array(nodeSchema, { maxLength: 1000 }),
  /** Milliseconds since 1970 of the reading. */
  at: number({ integer: true, min: 0 }),
});

export const redisInfoProtocol = defineProtocol({
  host: {
    requests: {
      /** Reads INFO again. */
      refresh: { params: object({}), result: object({}) },
    },
    events: {
      ready: object({}),
    },
  },
  webview: {
    requests: {},
    events: {
      state: infoStateSchema,
    },
  },
});

export type RedisInfoProtocol = typeof redisInfoProtocol;
export type RedisInfoState = Infer<typeof infoStateSchema>;
export type RedisInfoNode = Infer<typeof nodeSchema>;
