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
} as const;

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
}

export interface ConnectionConfig extends ConnectionInput {
  readonly id: string;
}

/** A config with its secret resolved, ready to be passed to a driver. */
export interface ResolvedConnectionConfig extends ConnectionConfig {
  readonly password?: string;
}

/** The port a driver should actually use. */
export function effectivePort(config: ConnectionInput): number | undefined {
  return config.port ?? DEFAULT_PORTS[config.driver];
}

/**
 * Problems that make a config unusable, as stable codes (the UI translates them).
 * An empty array means the config is valid.
 */
export type ConnectionProblem = 'name-empty' | 'host-empty' | 'port-invalid' | 'file-empty';

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
    if (
      input.port !== undefined &&
      (!Number.isInteger(input.port) || input.port < 1 || input.port > 65_535)
    ) {
      problems.push('port-invalid');
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
