// The saved description of a connection. Passwords never live here: they are
// kept in SecretStorage and joined in only at connect time (ARCHITECTURE.md §8).

export const DRIVER_IDS = [
  'mysql',
  'postgres',
  'sqlite',
  'mssql',
  'clickhouse',
  'oracle',
  'redis',
  'mongodb',
] as const;

export type DriverId = (typeof DRIVER_IDS)[number];

export function isDriverId(value: unknown): value is DriverId {
  return typeof value === 'string' && (DRIVER_IDS as readonly string[]).includes(value);
}

/**
 * What a database speaks (D81): SQL drivers share the dialect, the result grid and the
 * SQL editor; Redis has commands and keys, MongoDB collections of documents (D88), each
 * with a UI of its own. Connections, folders, secrets, SSH and the connection form are
 * the same for all.
 */
export type DriverFamily = 'sql' | 'redis' | 'mongodb';

export function driverFamily(driver: DriverId): DriverFamily {
  return driver === 'redis' || driver === 'mongodb' ? driver : 'sql';
}

export type SqlDriverId = Exclude<DriverId, 'redis' | 'mongodb'>;

export function isSqlDriver(driver: DriverId): driver is SqlDriverId {
  return driverFamily(driver) === 'sql';
}

/** The SQL drivers, in the order of `DRIVER_IDS`. */
export const SQL_DRIVER_IDS: readonly SqlDriverId[] = DRIVER_IDS.filter(isSqlDriver);

/** Drivers that open a local file instead of a network connection. */
export function isFileDriver(driver: DriverId): boolean {
  return driver === 'sqlite';
}

/** Default server port when the user leaves the field empty. */
export const DEFAULT_PORTS: Readonly<Partial<Record<DriverId, number>>> = {
  mysql: 3306,
  postgres: 5432,
  mssql: 1433,
  // The HTTP interface; HTTPS is 8443, which DataNest picks when TLS is on.
  clickhouse: 8123,
  oracle: 1521,
  redis: 6379,
  mongodb: 27_017,
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

/**
 * How a Redis connection finds its server (V7.1): one server, the master a group of
 * Sentinels names, or a cluster that shares the keys between its masters.
 */
export const REDIS_MODES = ['standalone', 'sentinel', 'cluster'] as const;

export type RedisMode = (typeof REDIS_MODES)[number];

/** Default port of a Sentinel, for addresses that leave it out. */
export const DEFAULT_SENTINEL_PORT = 26_379;

/** Most extra Sentinels or cluster seed nodes a connection lists. */
export const MAX_REDIS_NODES = 20;

/** Another server of a topology: a Sentinel, a cluster node, a replica set member. */
export interface NodeAddress {
  readonly host: string;
  readonly port?: number;
}

export type RedisNodeAddress = NodeAddress;

/**
 * Redis settings beyond host and port. In `sentinel` mode `host:port` is the first
 * Sentinel, in `cluster` mode the first node; `nodes` lists more of them, tried when
 * the first does not answer. The Sentinels' own password is a secret, kept apart.
 */
export interface RedisSettings {
  readonly mode: RedisMode;
  /** The name of the master the Sentinels watch (`sentinel monitor <name> …`). */
  readonly masterName?: string;
  readonly nodes?: readonly RedisNodeAddress[];
  /** The ACL user of the Sentinels, when they ask for one. */
  readonly sentinelUser?: string;
}

/** The mode of a Redis config; settings left out mean one server. */
export function redisModeOf(config: Pick<ConnectionInput, 'redis'>): RedisMode {
  return config.redis?.mode ?? 'standalone';
}

/**
 * How a MongoDB connection finds its servers (V7.5): straight to the one server it
 * names (and only it), a replica set found from seed members (the primary takes the
 * changes), or the seed list a DNS SRV record publishes (`mongodb+srv://`, Atlas).
 */
export const MONGO_MODES = ['direct', 'replicaSet', 'srv'] as const;

export type MongoMode = (typeof MONGO_MODES)[number];

/** Ways to sign in that need nothing beyond the driver itself. */
export const MONGO_AUTH_MECHANISMS = [
  'SCRAM-SHA-256',
  'SCRAM-SHA-1',
  'PLAIN',
  'MONGODB-X509',
] as const;

export type MongoAuthMechanism = (typeof MONGO_AUTH_MECHANISMS)[number];

/** Most extra replica set members a connection lists. */
export const MAX_MONGO_NODES = 50;

/**
 * MongoDB settings beyond host and port. In `replicaSet` mode `host:port` is the first
 * seed member and `nodes` lists more; in `srv` mode the host is the DNS name of the
 * record and has no port.
 */
export interface MongoSettings {
  readonly mode: MongoMode;
  /** The name of the replica set, checked against what the members say. */
  readonly replicaSet?: string;
  readonly nodes?: readonly NodeAddress[];
  /** The database that holds the user; the connection's database, else `admin`. */
  readonly authSource?: string;
  /** Left out, the server and the driver agree on a SCRAM mechanism. */
  readonly authMechanism?: MongoAuthMechanism;
}

/** The mode of a MongoDB config; settings left out mean one server, directly. */
export function mongoModeOf(config: Pick<ConnectionInput, 'mongo'>): MongoMode {
  return config.mongo?.mode ?? 'direct';
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

/**
 * How sessions of a connection are opened and kept (V4.9). Each field left out keeps
 * DataNest's default; a driver ignores what it has no use for (`optionSupport`).
 */
export interface ConnectionOptions {
  /** Seconds to wait for the server (and each SSH hop) when connecting. */
  readonly connectTimeout?: number;
  /** Seconds a statement may run; overrides `datanest.queryTimeout`, 0 means no limit. */
  readonly queryTimeout?: number;
  /** Seconds of quiet after which an idle session sends `SELECT 1`; absent or 0: never. */
  readonly keepAlive?: number;
  /** Statements every new session runs first, e.g. `SET search_path = app`. */
  readonly initSql?: string;
  /** Session time zone: `UTC`, `+03:00`, `Europe/Berlin`. */
  readonly timeZone?: string;
  /** MySQL character set of the session, e.g. `latin1`; `utf8mb4` when absent. */
  readonly charset?: string;
}

export const OPTION_LIMITS = {
  connectTimeout: { min: 1, max: 300 },
  queryTimeout: { min: 0, max: 86_400 },
  keepAlive: { min: 0, max: 3600 },
  initSql: 20_000,
  timeZone: 64,
  charset: 32,
} as const;

/** Seconds to connect when the connection does not say. */
export const DEFAULT_CONNECT_TIMEOUT_SECONDS = 10;

/** Which options a driver honours; the form shows only those. */
export interface OptionSupport {
  readonly connectTimeout: boolean;
  readonly keepAlive: boolean;
  readonly timeZone: boolean;
  readonly charset: boolean;
  /** TLS to the server (not for files, and not yet for Oracle's TCPS). */
  readonly tls: boolean;
  /** A limit on how long one statement may run; Redis commands have none. */
  readonly queryTimeout: boolean;
  /** Statements (or Redis commands) every new session runs first. */
  readonly init: boolean;
}

export function optionSupport(driver: DriverId): OptionSupport {
  switch (driver) {
    case 'mysql':
      return {
        connectTimeout: true,
        keepAlive: true,
        timeZone: true,
        charset: true,
        tls: true,
        queryTimeout: true,
        init: true,
      };
    // pg decodes every result as UTF-8, so another client encoding would garble text.
    case 'postgres':
      return {
        connectTimeout: true,
        keepAlive: true,
        timeZone: true,
        charset: false,
        tls: true,
        queryTimeout: true,
        init: true,
      };
    // A file has no network to wait for or keep alive, and no session time zone.
    case 'sqlite':
      return {
        connectTimeout: false,
        keepAlive: false,
        timeZone: false,
        charset: false,
        tls: false,
        queryTimeout: true,
        init: true,
      };
    // SQL Server sessions have no time zone of their own, and N'…' text needs no charset.
    case 'mssql':
      return {
        connectTimeout: true,
        keepAlive: true,
        timeZone: false,
        charset: false,
        tls: true,
        queryTimeout: true,
        init: true,
      };
    // HTTP carries UTF-8; the time zone is the session_timezone setting.
    case 'clickhouse':
      return {
        connectTimeout: true,
        keepAlive: true,
        timeZone: true,
        charset: false,
        tls: true,
        queryTimeout: true,
        init: true,
      };
    // TCPS needs a wallet on the server; until it is supported, Oracle goes plain or via SSH.
    case 'oracle':
      return {
        connectTimeout: true,
        keepAlive: true,
        timeZone: true,
        charset: false,
        tls: false,
        queryTimeout: true,
        init: true,
      };
    // Init SQL holds Redis commands instead, one per line; a running command has no
    // limit of DataNest's, because blocking reads wait on purpose.
    case 'redis':
      return {
        connectTimeout: true,
        keepAlive: true,
        timeZone: false,
        charset: false,
        tls: true,
        queryTimeout: false,
        init: true,
      };
    // A query may run as long as `maxTimeMS` allows; nothing to run on connect.
    case 'mongodb':
      return {
        connectTimeout: true,
        keepAlive: true,
        timeZone: false,
        charset: false,
        tls: true,
        queryTimeout: true,
        init: false,
      };
  }
}

/**
 * Which databases and schemas the tree and the object search show (V4.10), as
 * patterns: `app_*`, `billing`, and `!app_test` to hide one. None shows all.
 */
export interface VisibilityFilter {
  readonly databases?: readonly string[];
  /** Applies to the schemas of every database of the connection. */
  readonly schemas?: readonly string[];
}

export const FILTER_LIMITS = { patterns: 100, pattern: 200 } as const;

/** Which lists a driver has to filter: MySQL has no schemas, a SQLite file neither. */
export function filterSupport(driver: DriverId): { databases: boolean; schemas: boolean } {
  switch (driver) {
    case 'mysql':
      return { databases: true, schemas: false };
    case 'postgres':
      return { databases: true, schemas: true };
    case 'sqlite':
      return { databases: false, schemas: false };
    case 'mssql':
      return { databases: true, schemas: true };
    case 'clickhouse':
      return { databases: true, schemas: false };
    // The database is the one service the connection names.
    case 'oracle':
      return { databases: false, schemas: true };
    // Numbered databases, all listed.
    case 'redis':
      return { databases: false, schemas: false };
    case 'mongodb':
      return { databases: true, schemas: false };
  }
}

/** Everything the user edits in the connection form; `id` is assigned by the store. */
export interface ConnectionInput {
  readonly name: string;
  readonly driver: DriverId;
  readonly host?: string;
  readonly port?: number;
  readonly user?: string;
  /**
   * Initial database (MySQL) or database name (PostgreSQL); the number of a Redis one;
   * the database a MongoDB connection opens first (and signs in to, unless told otherwise).
   */
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
  /** A production database: it stands out, and every change is confirmed first. */
  readonly production?: boolean;
  /**
   * Nothing may change it: changing statements are refused before they run, and the
   * session itself is opened read-only, so the server refuses what slips through.
   */
  readonly readOnly?: boolean;
  /** Timeouts, keep-alive, init SQL, time zone and character set (V4.9). */
  readonly options?: ConnectionOptions;
  /** Databases and schemas to show (V4.10). */
  readonly filter?: VisibilityFilter;
  /** Sentinel or cluster (V7.1); Redis connections only. */
  readonly redis?: RedisSettings;
  /** Replica set, SRV and sign-in (V7.5); MongoDB connections only. */
  readonly mongo?: MongoSettings;
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
  if (config.port !== undefined) {
    return config.port;
  }
  // In Sentinel mode the address is the first Sentinel's; an SRV record has no port.
  if (config.driver === 'redis' && redisModeOf(config) === 'sentinel') {
    return DEFAULT_SENTINEL_PORT;
  }
  if (config.driver === 'mongodb' && mongoModeOf(config) === 'srv') {
    return undefined;
  }
  return DEFAULT_PORTS[config.driver];
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
  | OptionProblem
  | 'filter-too-long'
  | RedisProblem
  | MongoProblem
  | SshProblem;

/** What is wrong with the Redis settings. */
export type RedisProblem =
  /** Sentinel mode needs the name of the master. */
  | 'redis-master-empty'
  /** An extra Sentinel or cluster node without a host or with a bad port. */
  | 'redis-node-invalid'
  | 'redis-too-many-nodes'
  /** The database is a number: 0, 1, … */
  | 'redis-database-invalid'
  /** A cluster has database 0 only. */
  | 'redis-cluster-database'
  /**
   * A Sentinel and a cluster hand out the addresses of other servers, which a tunnel
   * to one of them cannot reach.
   */
  | 'redis-ssh-topology';

/** What is wrong with the MongoDB settings. */
export type MongoProblem =
  /** Another member without a host or with a bad port. */
  | 'mongo-node-invalid'
  | 'mongo-too-many-nodes'
  /** An SRV record is a DNS name: no port, no other members. */
  | 'mongo-srv-port'
  /** Names of a replica set and of the user's database are plain words. */
  | 'mongo-name-invalid'
  /**
   * A replica set and an SRV record hand out the addresses of other members, which a
   * tunnel to one of them cannot reach.
   */
  | 'mongo-ssh-topology';

/** What is wrong with the session options. */
export type OptionProblem =
  | 'connect-timeout-invalid'
  | 'query-timeout-invalid'
  | 'keep-alive-invalid'
  | 'time-zone-invalid'
  | 'charset-invalid'
  | 'init-sql-too-long';

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

function inRange(value: number | undefined, range: { min: number; max: number }): boolean {
  return (
    value === undefined || (Number.isInteger(value) && value >= range.min && value <= range.max)
  );
}

/** Problems of the session options; empty strings count as left out. */
export function optionProblems(options: ConnectionOptions | undefined): OptionProblem[] {
  if (options === undefined) {
    return [];
  }
  const problems: OptionProblem[] = [];
  if (!inRange(options.connectTimeout, OPTION_LIMITS.connectTimeout)) {
    problems.push('connect-timeout-invalid');
  }
  if (!inRange(options.queryTimeout, OPTION_LIMITS.queryTimeout)) {
    problems.push('query-timeout-invalid');
  }
  if (!inRange(options.keepAlive, OPTION_LIMITS.keepAlive)) {
    problems.push('keep-alive-invalid');
  }
  const zone = options.timeZone ?? '';
  // A zone becomes a quoted literal, so only control characters could hurt; the
  // server says whether it knows the name.
  if (zone.length > OPTION_LIMITS.timeZone || /\p{Cc}/u.test(zone)) {
    problems.push('time-zone-invalid');
  }
  const charset = options.charset ?? '';
  if (charset !== '' && !/^[A-Za-z0-9_]{1,32}$/.test(charset)) {
    problems.push('charset-invalid');
  }
  if ((options.initSql ?? '').length > OPTION_LIMITS.initSql) {
    problems.push('init-sql-too-long');
  }
  return problems;
}

/** Problems of the Redis side of a config; empty for other drivers. */
export function redisProblems(input: ConnectionInput): RedisProblem[] {
  if (input.driver !== 'redis') {
    return [];
  }
  const problems: RedisProblem[] = [];
  const mode = redisModeOf(input);
  const database = (input.database ?? '').trim();
  if (database !== '' && !/^\d{1,5}$/.test(database)) {
    problems.push('redis-database-invalid');
  } else if (mode === 'cluster' && database !== '' && Number(database) !== 0) {
    problems.push('redis-cluster-database');
  }
  if (mode === 'sentinel' && (input.redis?.masterName ?? '').trim() === '') {
    problems.push('redis-master-empty');
  }
  const nodes = input.redis?.nodes ?? [];
  if (nodes.some((node) => node.host.trim() === '' || !isPortValid(node.port))) {
    problems.push('redis-node-invalid');
  }
  if (nodes.length > MAX_REDIS_NODES) {
    problems.push('redis-too-many-nodes');
  }
  if (mode !== 'standalone' && input.ssh !== undefined) {
    problems.push('redis-ssh-topology');
  }
  return problems;
}

/** Characters a replica set or database name never holds (MongoDB's own rules). */
const MONGO_NAME_FORBIDDEN = /[/\\. "$*<>:|?]|\0/u;

/** Problems of the MongoDB side of a config; empty for other drivers. */
export function mongoProblems(input: ConnectionInput): MongoProblem[] {
  if (input.driver !== 'mongodb') {
    return [];
  }
  const problems: MongoProblem[] = [];
  const mode = mongoModeOf(input);
  const nodes = input.mongo?.nodes ?? [];
  if (nodes.some((node) => node.host.trim() === '' || !isPortValid(node.port))) {
    problems.push('mongo-node-invalid');
  }
  if (nodes.length > MAX_MONGO_NODES) {
    problems.push('mongo-too-many-nodes');
  }
  if (mode === 'srv' && (input.port !== undefined || nodes.length > 0)) {
    problems.push('mongo-srv-port');
  }
  const replicaSet = (input.mongo?.replicaSet ?? '').trim();
  const authSource = (input.mongo?.authSource ?? '').trim();
  if (
    (replicaSet !== '' && /[\s/,]/u.test(replicaSet)) ||
    (authSource !== '' && MONGO_NAME_FORBIDDEN.test(authSource) && authSource !== '$external')
  ) {
    problems.push('mongo-name-invalid');
  }
  if (mode !== 'direct' && input.ssh !== undefined) {
    problems.push('mongo-ssh-topology');
  }
  return problems;
}

export function connectionProblems(input: ConnectionInput): ConnectionProblem[] {
  const problems: ConnectionProblem[] = [];
  if (input.name.trim() === '') {
    problems.push('name-empty');
  }
  problems.push(...optionProblems(input.options));
  for (const patterns of [input.filter?.databases ?? [], input.filter?.schemas ?? []]) {
    if (
      patterns.length > FILTER_LIMITS.patterns ||
      patterns.some((pattern) => pattern.length > FILTER_LIMITS.pattern)
    ) {
      if (!problems.includes('filter-too-long')) {
        problems.push('filter-too-long');
      }
    }
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
    problems.push(...redisProblems(input));
    problems.push(...mongoProblems(input));
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
