// A saved SSH server for browsing its files over SFTP (V13.16). It is not a database
// connection: it has no driver or database, only the way to log in — the same hops, proxy and
// secrets a tunnel uses — and where to start looking.

import {
  CONNECTION_COLORS,
  type ConnectionColor,
  effectiveSshPort,
  hopsOfTunnel,
  type ProxySettings,
  type SshHop,
  sshHopProblems,
  type SshProblem,
  type SshTunnelConfig,
} from './connection';
import { proxySchema, sshTunnelSchema } from './connection-schema';
import { boolean, literal, object, optional, type Schema, string } from './schema';

export const SERVER_LIMITS = { name: 200, path: 4096 } as const;

/** What the user fills in. */
export interface SshServerInput {
  readonly name: string;
  readonly ssh: SshTunnelConfig;
  /** Reach the first SSH server through a SOCKS5 or HTTP proxy. */
  readonly proxy?: ProxySettings;
  /** The folder shown first; absent means the login folder of the user. */
  readonly startPath?: string;
  /** Nothing on this server may be changed from DataNest. */
  readonly readOnly?: boolean;
  readonly color?: ConnectionColor;
}

export interface SshServerConfig extends SshServerInput {
  readonly id: string;
}

const inputShape = {
  name: string({ minLength: 1, maxLength: SERVER_LIMITS.name }),
  ssh: sshTunnelSchema,
  proxy: optional(proxySchema),
  startPath: optional(string({ maxLength: SERVER_LIMITS.path })),
  readOnly: optional(boolean()),
  color: optional(literal(...CONNECTION_COLORS)),
};

export const sshServerInputSchema: Schema<SshServerInput> = object(inputShape);

export const sshServerSchema: Schema<SshServerConfig> = object({
  ...inputShape,
  id: string({ minLength: 1, maxLength: 100 }),
});

/** The hops of a server in the order they are connected: jump hosts first. */
export function serverHops(server: Pick<SshServerInput, 'ssh'>): readonly SshHop[] {
  return hopsOfTunnel(server.ssh);
}

/** `user@host` (and `:port` when it is not 22) of the server itself, the last hop. */
export function describeServer(server: Pick<SshServerInput, 'ssh'>): string {
  const { user, host } = server.ssh;
  const port = effectiveSshPort(server.ssh);
  return `${user}@${host}${port === 22 ? '' : `:${port}`}`;
}

export type ServerProblem = SshProblem | 'name-empty' | 'too-long';

/** Why a server cannot be saved; empty when it can. */
export function serverProblems(input: SshServerInput): ServerProblem[] {
  const problems: ServerProblem[] = [];
  if (input.name.trim() === '') {
    problems.push('name-empty');
  }
  if (
    input.name.length > SERVER_LIMITS.name ||
    (input.startPath?.length ?? 0) > SERVER_LIMITS.path
  ) {
    problems.push('too-long');
  }
  for (const hop of serverHops(input)) {
    for (const problem of sshHopProblems(hop)) {
      if (!problems.includes(problem)) {
        problems.push(problem);
      }
    }
  }
  return problems;
}
