// Runtime shapes of a connection, shared by the store (what is saved) and the
// connection form protocol (what the page sends), so the two never disagree.

import {
  CONNECTION_COLORS,
  CONNECTION_LIMITS,
  DRIVER_IDS,
  type ConnectionInput,
  type ConnectionOptions,
  FILTER_LIMITS,
  OPTION_LIMITS,
  type VisibilityFilter,
  SSH_AUTH_METHODS,
  type SshHop,
  type SshTunnelConfig,
  SSL_MODES,
  type SslSettings,
} from './connection';
import { array, boolean, literal, number, object, optional, type Schema, string } from './schema';

const port = (): Schema<number> => number({ integer: true, min: 1, max: 65_535 });

/** The fields of `SshHop`, to be reused by shapes that change one of them. */
export const sshHopShape = {
  id: string({ minLength: 1, maxLength: CONNECTION_LIMITS.hopId }),
  host: string({ maxLength: CONNECTION_LIMITS.field }),
  port: optional(port()),
  user: string({ maxLength: CONNECTION_LIMITS.field }),
  auth: literal(...SSH_AUTH_METHODS),
  keyFile: optional(string({ maxLength: CONNECTION_LIMITS.file })),
  agentSocket: optional(string({ maxLength: CONNECTION_LIMITS.file })),
};

export const sshHopSchema: Schema<SshHop> = object(sshHopShape);

/** The array limit is generous; `connectionProblems` holds the real one (MAX_SSH_JUMPS). */
export const sshTunnelSchema: Schema<SshTunnelConfig> = object({
  ...sshHopShape,
  jumps: optional(array(sshHopSchema, { maxLength: 20 })),
});

export const sslSchema: Schema<SslSettings> = object({
  mode: literal(...SSL_MODES),
  ca: optional(string({ maxLength: CONNECTION_LIMITS.file })),
  cert: optional(string({ maxLength: CONNECTION_LIMITS.file })),
  key: optional(string({ maxLength: CONNECTION_LIMITS.file })),
});

const seconds = (range: { min: number; max: number }): Schema<number> =>
  number({ integer: true, ...range });

export const optionsSchema: Schema<ConnectionOptions> = object({
  connectTimeout: optional(seconds(OPTION_LIMITS.connectTimeout)),
  queryTimeout: optional(seconds(OPTION_LIMITS.queryTimeout)),
  keepAlive: optional(seconds(OPTION_LIMITS.keepAlive)),
  initSql: optional(string({ maxLength: OPTION_LIMITS.initSql })),
  timeZone: optional(string({ maxLength: OPTION_LIMITS.timeZone })),
  charset: optional(string({ maxLength: OPTION_LIMITS.charset })),
});

const patternsSchema = array(string({ minLength: 1, maxLength: FILTER_LIMITS.pattern }), {
  maxLength: FILTER_LIMITS.patterns,
});

export const filterSchema: Schema<VisibilityFilter> = object({
  databases: optional(patternsSchema),
  schemas: optional(patternsSchema),
});

/** The fields of `ConnectionInput`, to be reused by shapes that add their own. */
export const connectionInputShape = {
  name: string({ maxLength: CONNECTION_LIMITS.name }),
  driver: literal(...DRIVER_IDS),
  host: optional(string({ maxLength: CONNECTION_LIMITS.field })),
  port: optional(port()),
  user: optional(string({ maxLength: CONNECTION_LIMITS.field })),
  database: optional(string({ maxLength: CONNECTION_LIMITS.field })),
  file: optional(string({ maxLength: CONNECTION_LIMITS.file })),
  ssh: optional(sshTunnelSchema),
  ssl: optional(sslSchema),
  folder: optional(string({ maxLength: CONNECTION_LIMITS.folder })),
  color: optional(literal(...CONNECTION_COLORS)),
  production: optional(boolean()),
  readOnly: optional(boolean()),
  options: optional(optionsSchema),
  filter: optional(filterSchema),
};

export const connectionInputSchema: Schema<ConnectionInput> = object(connectionInputShape);
