// The saved description of a connection. Passwords never live here: they are
// kept in SecretStorage and joined in only at connect time (ARCHITECTURE.md §8).

export const DRIVER_IDS = ['mysql', 'postgres', 'sqlite'] as const;

export type DriverId = (typeof DRIVER_IDS)[number];

export function isDriverId(value: unknown): value is DriverId {
  return typeof value === 'string' && (DRIVER_IDS as readonly string[]).includes(value);
}

/** Drivers that open a local file instead of a network connection. */
export function isFileDriver(driver: DriverId): boolean {
  return driver === 'sqlite';
}

/** Default server port when the user leaves the field empty. */
export const DEFAULT_PORTS: Readonly<Partial<Record<DriverId, number>>> = {
  mysql: 3306,
  postgres: 5432,
};

export const CONNECTION_LIMITS = {
  /** Display name. */
  name: 200,
  /** Host, user and database names. */
  field: 500,
  /** Path to a database file. */
  file: 4000,
  /** Id of an SSH hop; it becomes part of a SecretStorage key. */
  hopId: 64,
  /** Name of a folder in the tree. */
  folder: 200,
} as const;

/** Labels a connection can wear in the tree, e.g. red for production. */
export const CONNECTION_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'] as const;

export type ConnectionColor = (typeof CONNECTION_COLORS)[number];

/**
 * TLS to the database server. `require` encrypts but trusts any certificate;
 * `verify-ca` checks it was issued by a trusted CA; `verify-full` also checks it was
 * issued for this host (the names follow PostgreSQL's sslmode).
 */
export const SSL_MODES = ['require', 'verify-ca', 'verify-full'] as const;

export type SslMode = (typeof SSL_MODES)[number];

/** Certificate files are paths; their contents are read at connect time. */
export interface SslSettings {
  readonly mode: SslMode;
  /** CA certificate(s) to trust instead of the system's. */
  readonly ca?: string;
  /** Client certificate and its (unencrypted) key, for servers that ask for one. */
  readonly cert?: string;
  readonly key?: string;
}

/** How DataNest proves who it is to an SSH server. */
export const SSH_AUTH_METHODS = ['password', 'key', 'agent'] as const;

export type SshAuthMethod = (typeof SSH_AUTH_METHODS)[number];

export const DEFAULT_SSH_PORT = 22;

/** Characters a hop id may contain, so it is safe inside a secret key. */
export const HOP_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * One SSH server on the way to the database. Its password and key passphrase are
 * secrets: they live in SecretStorage under the hop's id, never here.
 */
export interface SshHop {
  /** Stable within the connection; names the hop's secrets. */
  readonly id: string;
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  readonly auth: SshAuthMethod;
  /** Private key file, for `key`. */
  readonly keyFile?: string;
  /**
   * Agent socket (or Windows pipe, or `pageant`), for `agent`. Empty means the
   * usual place: `SSH_AUTH_SOCK`, or the OpenSSH agent pipe on Windows.
   */
  readonly agentSocket?: string;
}

/** Most jump hosts a tunnel may pass through before its SSH server. */
export const MAX_SSH_JUMPS = 5;

/** The SSH server the database is reached through. */
export interface SshTunnelConfig extends SshHop {
  /**
   * Servers to pass through first, in order (OpenSSH's ProxyJump): DataNest logs in
   * to the first, reaches the next one through it, and so on up to this server.
   */
  readonly jumps?: readonly SshHop[];
}

/** A new hop id; unique enough within one connection. */
export function newHopId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Everything the user edits in the connection form; `id` is assigned by the store. */
export interface ConnectionInput {
  readonly name: string;
  readonly driver: DriverId;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  /** Initial database (MySQL) or database name (PostgreSQL). */
  readonly database?: string;
  /** Path to the database file for file-based drivers. */
  readonly file?: string;
  /** Reach the server through an SSH tunnel; network drivers only. */
  readonly ssh?: SshTunnelConfig;
  /** Encrypt the connection; absent means the driver's plain default. */
  readonly ssl?: SslSettings;
  /** The folder the tree shows it in; absent means the top level. */
  readonly folder?: string;
  readonly color?: ConnectionColor;
}

export interface ConnectionConfig extends ConnectionInput {
  readonly id: string;
}

/** A config with its secret resolved, ready to be passed to a driver. */
export interface ResolvedConnectionConfig extends ConnectionConfig {
  readonly password?: string;
  /**
   * The name to check the server's TLS certificate against when `host` is not the
   * server's own name, e.g. a local tunnel port in front of it.
   */
  readonly tlsServerName?: string;
}

/** The secrets of one SSH hop, as the store keeps them. */
export interface SshHopSecrets {
  readonly password?: string;
  readonly passphrase?: string;
}

/** The SSH hops of a config, in the order they are connected: jumps, then the server. */
export function sshHopsOf(config: ConnectionInput): readonly SshHop[] {
  if (config.ssh === undefined) {
    return [];
  }
  const { jumps = [], ...server } = config.ssh;
  return [...jumps, server];
}

export function effectiveSshPort(hop: SshHop): number {
  return hop.port ?? DEFAULT_SSH_PORT;
}

/** The port a driver should actually use. */
export function effectivePort(config: ConnectionInput): number | undefined {
  return config.port ?? DEFAULT_PORTS[config.driver];
}

/**
 * Problems that make a config unusable, as stable codes (the UI translates them).
 * An empty array means the config is valid.
 */
export type ConnectionProblem =
  | 'name-empty'
  | 'host-empty'
  | 'port-invalid'
  | 'file-empty'
  | 'ssl-cert-without-key'
  | 'ssl-key-without-cert'
  | SshProblem;

/** What is wrong with one SSH hop. */
export type SshProblem =
  | 'ssh-host-empty'
  | 'ssh-port-invalid'
  | 'ssh-user-empty'
  | 'ssh-key-empty'
  | 'ssh-id-invalid'
  | 'ssh-too-many-jumps';

function isPortValid(port: number | undefined): boolean {
  return port === undefined || (Number.isInteger(port) && port >= 1 && port <= 65_535);
}

export function sshHopProblems(hop: SshHop): SshProblem[] {
  const problems: SshProblem[] = [];
  if (hop.host.trim() === '') {
    problems.push('ssh-host-empty');
  }
  if (!isPortValid(hop.port)) {
    problems.push('ssh-port-invalid');
  }
  if (hop.user.trim() === '') {
    problems.push('ssh-user-empty');
  }
  if (hop.auth === 'key' && (hop.keyFile === undefined || hop.keyFile.trim() === '')) {
    problems.push('ssh-key-empty');
  }
  if (!HOP_ID_PATTERN.test(hop.id) || hop.id.length > CONNECTION_LIMITS.hopId) {
    problems.push('ssh-id-invalid');
  }
  return problems;
}

export function connectionProblems(input: ConnectionInput): ConnectionProblem[] {
  const problems: ConnectionProblem[] = [];
  if (input.name.trim() === '') {
    problems.push('name-empty');
  }
  if (isFileDriver(input.driver)) {
    if (input.file === undefined || input.file.trim() === '') {
      problems.push('file-empty');
    }
  } else {
    if (input.host === undefined || input.host.trim() === '') {
      problems.push('host-empty');
    }
    if (!isPortValid(input.port)) {
      problems.push('port-invalid');
    }
    const ids = new Set<string>();
    for (const hop of sshHopsOf(input)) {
      for (const problem of sshHopProblems(hop)) {
        if (!problems.includes(problem)) {
          problems.push(problem);
        }
      }
      // Two hops with one id would share their secrets.
      if (ids.has(hop.id) && !problems.includes('ssh-id-invalid')) {
        problems.push('ssh-id-invalid');
      }
      ids.add(hop.id);
    }
    if ((input.ssh?.jumps?.length ?? 0) > MAX_SSH_JUMPS) {
      problems.push('ssh-too-many-jumps');
    }
    // A client certificate is useless without its key, and the other way round.
    const hasCert = (input.ssl?.cert ?? '').trim() !== '';
    const hasKey = (input.ssl?.key ?? '').trim() !== '';
    if (hasCert && !hasKey) {
      problems.push('ssl-cert-without-key');
    }
    if (hasKey && !hasCert) {
      problems.push('ssl-key-without-cert');
    }
  }
  return problems;
}

/** A short "user@host:port" or file path for tooltips and pickers. Never contains secrets. */
export function describeTarget(config: ConnectionInput): string {
  if (isFileDriver(config.driver)) {
    return config.file ?? '';
  }
  const host = config.host ?? '';
  const port = effectivePort(config);
  const target = port === undefined ? host : `${host}:${port}`;
  return config.user === undefined || config.user === '' ? target : `${config.user}@${target}`;
}

/** "via user@bastion:22" for tooltips, or undefined for a direct connection. */
export function describeTunnel(config: ConnectionInput): string | undefined {
  const hops = sshHopsOf(config);
  if (hops.length === 0 || isFileDriver(config.driver)) {
    return undefined;
  }
  return hops.map((hop) => `${hop.user}@${hop.host}:${effectiveSshPort(hop)}`).join(' → ');
}
