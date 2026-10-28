// Runtime shapes of a connection, shared by the store (what is saved) and the
// connection form protocol (what the page sends), so the two never disagree.

import {
  CONNECTION_LIMITS,
  DRIVER_IDS,
  type ConnectionInput,
  SSH_AUTH_METHODS,
  type SshHop,
  type SshTunnelConfig,
} from './connection';
import { array, literal, number, object, optional, type Schema, string } from './schema';

const port = (): Schema<number> => number({ integer: true, min: 1, max: 65_535 });

const sshHopShape = {
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
};

export const connectionInputSchema: Schema<ConnectionInput> = object(connectionInputShape);
