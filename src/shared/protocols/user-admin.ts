// The users and privileges page (V8.6): the host reads accounts and what each may do,
// builds the statements of a change for the preview, and runs them when asked.

import { defineProtocol } from '../rpc';
import { array, boolean, type Infer, literal, object, optional, string } from '../schema';

const NAME = 1000;
const ROWS = 50_000;

export const GRANT_LEVELS = [
  'server',
  'database',
  'schema',
  'table',
  'allTables',
  'sequence',
  'routine',
  'role',
] as const;

const levelSchema = literal(...GRANT_LEVELS);
const names = array(string({ maxLength: NAME }), { maxLength: ROWS });

const userRefSchema = object({
  name: string({ maxLength: NAME }),
  host: optional(string({ maxLength: NAME })),
});

const userSchema = object({
  name: string({ maxLength: NAME }),
  host: optional(string({ maxLength: NAME })),
  login: boolean(),
  role: optional(boolean()),
  flags: array(string({ maxLength: NAME }), { maxLength: 50 }),
  memberOf: names,
  readOnly: optional(boolean()),
});

const targetShape = {
  level: levelSchema,
  database: optional(string({ maxLength: NAME })),
  schema: optional(string({ maxLength: NAME })),
  name: optional(string({ maxLength: NAME })),
  host: optional(string({ maxLength: NAME })),
};

const grantSchema = object({
  ...targetShape,
  privilege: string({ maxLength: NAME }),
  grantable: boolean(),
  fixed: optional(boolean()),
});

const privilegeNames = array(string({ maxLength: 100 }), { maxLength: 200 });

const featuresSchema = object({
  hosts: boolean(),
  tablesIn: literal('database', 'schema'),
  passwordOptional: boolean(),
  createOptions: array(string({ maxLength: 100 }), { maxLength: 20 }),
  lock: boolean(),
  /** The levels the grant form offers, in order, with the privileges of each. */
  levels: array(object({ level: levelSchema, privileges: privilegeNames }), { maxLength: 20 }),
});

const PASSWORD = string({ maxLength: 1000 });

/** One change the page asks to preview or run. */
const changeSchema = object({
  kind: literal('create', 'drop', 'password', 'lock', 'unlock', 'grant', 'revoke'),
  user: userRefSchema,
  role: optional(boolean()),
  password: optional(PASSWORD),
  options: optional(array(string({ maxLength: 100 }), { maxLength: 20 })),
  target: optional(object(targetShape)),
  privileges: optional(privilegeNames),
  grantable: optional(boolean()),
});

const stateSchema = object({
  connectionName: string({ maxLength: NAME }),
  /** `PostgreSQL`, `MariaDB`, …, once the host knows it. */
  server: optional(string({ maxLength: NAME })),
  /** The database whose objects the privileges are read in, where that matters. */
  database: optional(string({ maxLength: NAME })),
  features: optional(featuresSchema),
  /** The connection refuses changes: the page previews but never runs. */
  readOnly: boolean(),
  error: optional(string({ maxLength: 100_000 })),
});

export const userAdminProtocol = defineProtocol({
  host: {
    requests: {
      users: {
        params: object({}),
        result: object({ rows: array(userSchema, { maxLength: ROWS }) }),
      },
      grants: {
        params: object({ user: userRefSchema }),
        result: object({ rows: array(grantSchema, { maxLength: ROWS }) }),
      },
      /** Names to suggest in the grant form. */
      objects: {
        params: object({
          kind: literal('database', 'schema', 'table'),
          database: optional(string({ maxLength: NAME })),
          schema: optional(string({ maxLength: NAME })),
        }),
        result: object({ names }),
      },
      /** The statements of a change, passwords hidden. */
      preview: {
        params: object({ change: changeSchema }),
        result: object({ statements: array(string({ maxLength: 100_000 }), { maxLength: 100 }) }),
      },
      /** Runs a change after the questions the connection asks for; false when declined. */
      run: { params: object({ change: changeSchema }), result: object({ done: boolean() }) },
      /** Opens the statements in an editor; refused for a change with a password. */
      openInEditor: { params: object({ change: changeSchema }), result: object({}) },
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

export type UserAdminProtocol = typeof userAdminProtocol;
export type UserAdminState = Infer<typeof stateSchema>;
export type AdminUser = Infer<typeof userSchema>;
export type AdminGrant = Infer<typeof grantSchema>;
export type AdminChange = Infer<typeof changeSchema>;
export type AdminLevel = (typeof GRANT_LEVELS)[number];
