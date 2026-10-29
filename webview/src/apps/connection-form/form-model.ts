// Pure form logic: what the user typed → what the host receives, and which
// problems block saving. Kept apart from the component so it is tested directly.

import {
  type ConnectionColor,
  type ConnectionInput,
  type ConnectionProblem,
  connectionProblems,
  DEFAULT_SSH_PORT,
  type DriverId,
  isFileDriver,
  newHopId,
  type ConnectionOptions,
  filterSupport,
  type OptionProblem,
  optionSupport,
  DEFAULT_PORTS,
  DEFAULT_SENTINEL_PORT,
  type ElasticAuthMethod,
  type ElasticSettings,
  type MongoAuthMechanism,
  type MongoMode,
  type MongoSettings,
  type RedisMode,
  type RedisNodeAddress,
  type RedisSettings,
  type VisibilityFilter,
  type SshAuthMethod,
  type SshHop,
  type SshProblem,
  sshHopProblems,
  type SslMode,
} from '../../../../src/shared/connection';
import type {
  ConnectionDraft,
  ConnectionFormState,
} from '../../../../src/shared/protocols/connection-form';
import type { ParsedConnectionUrl, UrlProblem } from '../../../../src/shared/connection-url';
import { parsePatterns } from '../../../../src/shared/name-filter';
import type { ServerPreset } from '../../../../src/shared/server-presets';
import type { MessageKey } from '../../l10n/en';

/** A secret box: what was typed, whether it was, and whether to erase the stored one. */
export interface SecretField {
  value: string;
  touched: boolean;
  erase: boolean;
}

export function emptySecret(): SecretField {
  return { value: '', touched: false, erase: false };
}

/** One SSH server as the form edits it. */
export interface HopFields {
  id: string;
  host: string;
  port: string;
  user: string;
  auth: SshAuthMethod;
  keyFile: string;
  agentSocket: string;
  password: SecretField;
  passphrase: SecretField;
}

export function newHopFields(id: string = newHopId()): HopFields {
  return {
    id,
    host: '',
    port: '',
    user: '',
    auth: 'password',
    keyFile: '',
    agentSocket: '',
    password: emptySecret(),
    passphrase: emptySecret(),
  };
}

export function hopFieldsFrom(hop: SshHop): HopFields {
  return {
    id: hop.id,
    host: hop.host,
    port: hop.port === undefined ? '' : String(hop.port),
    user: hop.user,
    auth: hop.auth,
    keyFile: hop.keyFile ?? '',
    agentSocket: hop.agentSocket ?? '',
    password: emptySecret(),
    passphrase: emptySecret(),
  };
}

/** Everything the form holds; ports stay text while the user types. */
export interface FormFields {
  name: string;
  driver: DriverId;
  host: string;
  port: string;
  user: string;
  database: string;
  file: string;
  /** What the user typed into the password box. */
  password: string;
  /** True once the user edited the password box. */
  passwordTouched: boolean;
  /** The user asked to erase the stored password. */
  erasePassword: boolean;
  /** Connect through an SSH server. */
  useSsh: boolean;
  /** Kept while SSH is off, so turning it back on restores what was typed. */
  ssh: HopFields;
  /** Servers to pass through before `ssh`, in order. */
  jumps: HopFields[];
  /** `off` leaves TLS to the driver's default, which is a plain connection. */
  sslMode: SslMode | 'off';
  sslCa: string;
  sslCert: string;
  sslKey: string;
  folder: string;
  color: ConnectionColor | '';
  production: boolean;
  readOnly: boolean;
  /** Key of the project whose file keeps the connection; empty for the user's own list. */
  project: string;
  /** Session options (V4.9), as typed; seconds stay text until they are checked. */
  connectTimeout: string;
  queryTimeout: string;
  keepAlive: string;
  timeZone: string;
  charset: string;
  initSql: string;
  /** Patterns of the visible databases and schemas (V4.10), comma separated. */
  filterDatabases: string;
  filterSchemas: string;
  /** Redis (V7.1): one server, through Sentinels, or a cluster. */
  redisMode: RedisMode;
  /** The master the Sentinels watch. */
  masterName: string;
  /** More Sentinels or cluster nodes: `host:port`, separated by commas or blanks. */
  redisNodes: string;
  sentinelUser: string;
  sentinelPassword: SecretField;
  /** MongoDB (V7.5): one server, a replica set, or an SRV record. */
  mongoMode: MongoMode;
  replicaSet: string;
  /** More replica set members, as for Redis nodes. */
  mongoNodes: string;
  authSource: string;
  /** Empty: the server and the driver agree on SCRAM. */
  authMechanism: MongoAuthMechanism | '';
  /** Elasticsearch (V7.8): a user and password, or an API key in the password box. */
  elasticAuth: ElasticAuthMethod;
  elasticPrefix: string;
}

/** The option fields that hold seconds, with the problem a bad number gives. */
const SECOND_FIELDS = [
  ['connectTimeout', 'connect-timeout-invalid'],
  ['queryTimeout', 'query-timeout-invalid'],
  ['keepAlive', 'keep-alive-invalid'],
] as const satisfies readonly (readonly [
  keyof ConnectionOptions & keyof FormFields,
  OptionProblem,
])[];

export function fieldsFrom(state: ConnectionFormState): FormFields {
  const { input } = state;
  return {
    name: input.name,
    driver: input.driver,
    host: input.host ?? '',
    port: input.port === undefined ? '' : String(input.port),
    user: input.user ?? '',
    database: input.database ?? '',
    file: input.file ?? '',
    password: '',
    passwordTouched: false,
    erasePassword: false,
    useSsh: input.ssh !== undefined,
    ssh: input.ssh === undefined ? newHopFields() : hopFieldsFrom(input.ssh),
    jumps: (input.ssh?.jumps ?? []).map(hopFieldsFrom),
    sslMode: input.ssl?.mode ?? 'off',
    sslCa: input.ssl?.ca ?? '',
    sslCert: input.ssl?.cert ?? '',
    sslKey: input.ssl?.key ?? '',
    folder: input.folder ?? '',
    color: input.color ?? '',
    production: input.production === true,
    readOnly: input.readOnly === true,
    project: state.project?.key ?? '',
    connectTimeout: secondsText(input.options?.connectTimeout),
    queryTimeout: secondsText(input.options?.queryTimeout),
    keepAlive: secondsText(input.options?.keepAlive),
    timeZone: input.options?.timeZone ?? '',
    charset: input.options?.charset ?? '',
    initSql: input.options?.initSql ?? '',
    filterDatabases: (input.filter?.databases ?? []).join(', '),
    filterSchemas: (input.filter?.schemas ?? []).join(', '),
    redisMode: input.redis?.mode ?? 'standalone',
    masterName: input.redis?.masterName ?? '',
    redisNodes: (input.redis?.nodes ?? []).map(nodeText).join(', '),
    sentinelUser: input.redis?.sentinelUser ?? '',
    sentinelPassword: emptySecret(),
    ...mongoFieldsFrom(input),
    elasticAuth: input.elastic?.auth ?? 'basic',
    elasticPrefix: input.elastic?.pathPrefix ?? '',
  };
}

/** The Elasticsearch settings to send; none for a user and password at the root. */
export function toElastic(fields: FormFields): ElasticSettings | undefined {
  if (fields.driver !== 'elasticsearch') {
    return undefined;
  }
  const prefix = fields.elasticPrefix.trim();
  return fields.elasticAuth === 'basic' && prefix === ''
    ? undefined
    : { auth: fields.elasticAuth, ...(prefix === '' ? {} : { pathPrefix: prefix }) };
}

type MongoFields = Pick<
  FormFields,
  'mongoMode' | 'replicaSet' | 'mongoNodes' | 'authSource' | 'authMechanism'
>;

function mongoFieldsFrom(input: ConnectionInput): MongoFields {
  return {
    mongoMode: input.mongo?.mode ?? 'direct',
    replicaSet: input.mongo?.replicaSet ?? '',
    mongoNodes: (input.mongo?.nodes ?? []).map(nodeText).join(', '),
    authSource: input.mongo?.authSource ?? '',
    authMechanism: input.mongo?.authMechanism ?? '',
  };
}

/** The MongoDB settings to send; none for one server signing in the usual way. */
export function toMongo(fields: FormFields): MongoSettings | undefined {
  if (fields.driver !== 'mongodb') {
    return undefined;
  }
  const { nodes } = parseNodes(fields.mongoNodes);
  const replicaSet = fields.mongoMode === 'replicaSet' ? trim(fields.replicaSet) : undefined;
  const authSource = trim(fields.authSource);
  const settings: MongoSettings = {
    mode: fields.mongoMode,
    ...(replicaSet === undefined ? {} : { replicaSet }),
    ...(fields.mongoMode === 'replicaSet' && nodes.length > 0 ? { nodes } : {}),
    ...(authSource === undefined ? {} : { authSource }),
    ...(fields.authMechanism === '' ? {} : { authMechanism: fields.authMechanism }),
  };
  return Object.keys(settings).length === 1 && settings.mode === 'direct' ? undefined : settings;
}

/**
 * An SRV record has no port, and Atlas speaks TLS: choosing SRV clears the port and turns
 * a plain connection into a checked one; leaving SRV puts the default port back.
 */
export function changeMongoMode(fields: FormFields, mode: MongoMode): void {
  if (mode === 'srv') {
    fields.port = '';
    if (fields.sslMode === 'off') {
      fields.sslMode = 'verify-full';
    }
  } else if (fields.mongoMode === 'srv' && fields.port.trim() === '') {
    fields.port = String(DEFAULT_PORTS.mongodb);
  }
  fields.mongoMode = mode;
}

/** `host:port`, with brackets around an IPv6 address; the port only when set. */
export function nodeText(node: RedisNodeAddress): string {
  const host = node.host.includes(':') ? `[${node.host}]` : node.host;
  return node.port === undefined ? host : `${host}:${node.port}`;
}

/**
 * The extra Sentinels or nodes typed into one box: `a:26379, b`, `[::1]:7000`. A port
 * that is not a number makes the list invalid; the nodes before it are still read.
 */
export function parseNodes(text: string): { nodes: RedisNodeAddress[]; invalid: boolean } {
  const nodes: RedisNodeAddress[] = [];
  let invalid = false;
  for (const item of text.split(/[\s,;]+/).filter((part) => part !== '')) {
    const match = /^(\[[^\]]*\]|[^:]*)(?::(.*))?$/.exec(item);
    const rawHost = match?.[1] ?? '';
    const host = rawHost.startsWith('[') ? rawHost.slice(1, -1) : rawHost;
    const portText = match?.[2];
    const port = portText === undefined ? undefined : parsePort(portText);
    if (
      host === '' ||
      (portText !== undefined && (port === undefined || port < 1 || port > 65_535))
    ) {
      invalid = true;
      continue;
    }
    nodes.push(port === undefined ? { host } : { host, port });
  }
  return { nodes, invalid };
}

/** The Redis settings to send; none for one server, which is the default. */
export function toRedis(fields: FormFields): RedisSettings | undefined {
  if (fields.driver !== 'redis' || fields.redisMode === 'standalone') {
    return undefined;
  }
  const { nodes } = parseNodes(fields.redisNodes);
  const masterName = fields.redisMode === 'sentinel' ? trim(fields.masterName) : undefined;
  const sentinelUser = fields.redisMode === 'sentinel' ? trim(fields.sentinelUser) : undefined;
  return {
    mode: fields.redisMode,
    ...(masterName === undefined ? {} : { masterName }),
    ...(nodes.length === 0 ? {} : { nodes }),
    ...(sentinelUser === undefined ? {} : { sentinelUser }),
  };
}

/** SSH reaches one server only: Sentinels, clusters and replica sets hand out other addresses. */
export function sshAllowed(
  fields: Pick<FormFields, 'driver' | 'redisMode' | 'mongoMode'>,
): boolean {
  if (fields.driver === 'redis') {
    return fields.redisMode === 'standalone';
  }
  return fields.driver !== 'mongodb' || fields.mongoMode === 'direct';
}

/**
 * Switching between one server and Sentinels moves a default port to the other default,
 * so `6379` does not stay behind as the Sentinel's port; a typed port stays.
 */
export function changeRedisMode(fields: FormFields, mode: RedisMode): void {
  const serverPort = String(DEFAULT_PORTS.redis);
  const sentinelPort = String(DEFAULT_SENTINEL_PORT);
  const port = fields.port.trim();
  if (mode === 'sentinel' && (port === '' || port === serverPort)) {
    fields.port = sentinelPort;
  } else if (mode !== 'sentinel' && port === sentinelPort) {
    fields.port = serverPort;
  }
  fields.redisMode = mode;
}

/** The lists the driver has, from the typed patterns; none at all is no filter. */
export function toFilter(fields: FormFields): VisibilityFilter | undefined {
  const support = filterSupport(fields.driver);
  const databases = support.databases ? parsePatterns(fields.filterDatabases) : [];
  const schemas = support.schemas ? parsePatterns(fields.filterSchemas) : [];
  if (databases.length === 0 && schemas.length === 0) {
    return undefined;
  }
  return {
    ...(databases.length === 0 ? {} : { databases }),
    ...(schemas.length === 0 ? {} : { schemas }),
  };
}

function secondsText(value: number | undefined): string {
  return value === undefined ? '' : String(value);
}

/**
 * The options the chosen driver honours; blanks are left out, and so is the whole
 * object when nothing is set. A number that is not one is left out (and flagged).
 */
export function toOptions(fields: FormFields): ConnectionOptions | undefined {
  const support = optionSupport(fields.driver);
  const offered: Record<(typeof SECOND_FIELDS)[number][0], boolean> = {
    connectTimeout: support.connectTimeout,
    queryTimeout: true,
    keepAlive: support.keepAlive,
  };
  const options: Record<string, string | number> = {};
  for (const [field] of SECOND_FIELDS) {
    const value = parseSeconds(fields[field]);
    if (offered[field] && value !== undefined) {
      options[field] = value;
    }
  }
  const initSql = fields.initSql.trim() === '' ? undefined : fields.initSql;
  const timeZone = support.timeZone ? trim(fields.timeZone) : undefined;
  const charset = support.charset ? trim(fields.charset) : undefined;
  if (initSql !== undefined) {
    options.initSql = initSql;
  }
  if (timeZone !== undefined) {
    options.timeZone = timeZone;
  }
  if (charset !== undefined) {
    options.charset = charset;
  }
  return Object.keys(options).length === 0 ? undefined : options;
}

/**
 * Folder, color and the production and read-only flags apply to every driver. A project
 * connection has no folder: the project is its folder in the tree.
 */
function arrangement(
  fields: FormFields,
): Pick<ConnectionInput, 'folder' | 'color' | 'production' | 'readOnly'> {
  const folder = fields.project === '' ? trim(fields.folder) : undefined;
  return {
    ...(folder === undefined ? {} : { folder }),
    ...(fields.color === '' ? {} : { color: fields.color }),
    ...(fields.production ? { production: true } : {}),
    ...(fields.readOnly ? { readOnly: true } : {}),
  };
}

/** The TLS settings to send; none when TLS is off. Files are kept as typed, trimmed. */
export function toSsl(fields: FormFields): ConnectionInput['ssl'] {
  if (fields.sslMode === 'off' || !optionSupport(fields.driver).tls) {
    return undefined;
  }
  const ca = trim(fields.sslCa);
  const cert = trim(fields.sslCert);
  const key = trim(fields.sslKey);
  return {
    mode: fields.sslMode,
    ...(ca === undefined ? {} : { ca }),
    ...(cert === undefined ? {} : { cert }),
    ...(key === undefined ? {} : { key }),
  };
}

/** Moves the jump at `index` one place up (-1) or down (+1); out of range does nothing. */
export function moveJump(jumps: HopFields[], index: number, by: -1 | 1): void {
  const target = index + by;
  const moved = jumps[index];
  const other = jumps[target];
  if (moved === undefined || other === undefined) {
    return;
  }
  jumps[target] = moved;
  jumps[index] = other;
}

/** A port is kept only when it is written as a plain number. */
export function parsePort(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** Seconds are whole numbers written in digits, as ports are. */
export function parseSeconds(text: string): number | undefined {
  return parsePort(text);
}

function trim(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** The hop as the model has it; a port that is not a number is left out (and flagged). */
export function toHop(hop: HopFields): SshHop {
  const port = parsePort(hop.port);
  const keyFile = hop.auth === 'key' ? trim(hop.keyFile) : undefined;
  const agentSocket = hop.auth === 'agent' ? trim(hop.agentSocket) : undefined;
  return {
    id: hop.id,
    host: hop.host.trim(),
    ...(port === undefined ? {} : { port }),
    user: hop.user.trim(),
    auth: hop.auth,
    ...(keyFile === undefined ? {} : { keyFile }),
    ...(agentSocket === undefined ? {} : { agentSocket }),
  };
}

/** Only the fields that apply to the chosen driver are sent; blanks are dropped. */
export function toInput(fields: FormFields): ConnectionInput {
  const name = fields.name.trim();
  const options = toOptions(fields);
  const filter = toFilter(fields);
  if (isFileDriver(fields.driver)) {
    const file = trim(fields.file);
    return {
      name,
      driver: fields.driver,
      ...(file === undefined ? {} : { file }),
      ...arrangement(fields),
      ...(options === undefined ? {} : { options }),
    };
  }
  const host = trim(fields.host);
  const port = parsePort(fields.port);
  const ssl = toSsl(fields);
  const user = trim(fields.user);
  const database = trim(fields.database);
  const redis = toRedis(fields);
  const mongo = toMongo(fields);
  const elastic = toElastic(fields);
  // An API key signs in alone: a user name would only confuse the server.
  const signsWithKey = elastic?.auth === 'apiKey';
  return {
    name,
    driver: fields.driver,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(user === undefined || signsWithKey ? {} : { user }),
    ...(database === undefined || fields.driver === 'elasticsearch' ? {} : { database }),
    ...(fields.useSsh && sshAllowed(fields)
      ? {
          ssh: {
            ...toHop(fields.ssh),
            ...(fields.jumps.length === 0 ? {} : { jumps: fields.jumps.map(toHop) }),
          },
        }
      : {}),
    ...(ssl === undefined ? {} : { ssl }),
    ...arrangement(fields),
    ...(options === undefined ? {} : { options }),
    ...(filter === undefined ? {} : { filter }),
    ...(redis === undefined ? {} : { redis }),
    ...(mongo === undefined ? {} : { mongo }),
    ...(elastic === undefined ? {} : { elastic }),
  };
}

type SecretChange = ConnectionDraft['password'];

/**
 * What to do with a secret. Typing replaces it, the erase box clears it, and
 * leaving an untouched box alone keeps whatever is stored.
 */
export function secretChange(secret: SecretField): SecretChange {
  if (secret.erase) {
    return { kind: 'clear' };
  }
  if (secret.touched) {
    return secret.value === '' ? { kind: 'clear' } : { kind: 'set', value: secret.value };
  }
  return { kind: 'keep' };
}

export function passwordChange(fields: FormFields): SecretChange {
  return secretChange({
    value: fields.password,
    touched: fields.passwordTouched,
    erase: fields.erasePassword,
  });
}

/** A secret the hop's method does not use is erased, so a stale one is not kept. */
export function hopSecretChanges(hop: HopFields): NonNullable<ConnectionDraft['ssh']>[number] {
  return {
    hopId: hop.id,
    password: hop.auth === 'password' ? secretChange(hop.password) : { kind: 'clear' },
    passphrase: hop.auth === 'key' ? secretChange(hop.passphrase) : { kind: 'clear' },
  };
}

export function toDraft(fields: FormFields): ConnectionDraft {
  const input = toInput(fields);
  return {
    input,
    password: passwordChange(fields),
    ...(fields.project === '' ? {} : { project: fields.project }),
    // Only a Sentinel connection has the password; the store drops it for the others.
    ...(input.redis?.mode === 'sentinel'
      ? { sentinelPassword: secretChange(fields.sentinelPassword) }
      : {}),
    ...(input.ssh === undefined
      ? {}
      : { ssh: [...fields.jumps, fields.ssh].map((hop) => hopSecretChanges(hop)) }),
  };
}

/** Problems of one hop, including a port that is not a plain number. */
export function hopProblemsOf(hop: HopFields): SshProblem[] {
  const problems = sshHopProblems(toHop(hop));
  const port = hop.port.trim();
  if (port !== '' && parsePort(port) === undefined && !problems.includes('ssh-port-invalid')) {
    problems.push('ssh-port-invalid');
  }
  return problems;
}

/** Problems that block Test and Save; empty means the form is ready. */
export function problemsOf(fields: FormFields): ConnectionProblem[] {
  const problems = connectionProblems(toInput(fields));
  // A port that is not a plain number never reaches the model, so check the text.
  const port = fields.port.trim();
  if (
    !isFileDriver(fields.driver) &&
    port !== '' &&
    parsePort(port) === undefined &&
    !problems.includes('port-invalid')
  ) {
    problems.push('port-invalid');
  }
  // Seconds that are not a plain number never reach the model either.
  for (const [field, problem] of SECOND_FIELDS) {
    const text = fields[field].trim();
    if (text !== '' && parseSeconds(text) === undefined && !problems.includes(problem)) {
      problems.push(problem);
    }
  }
  if (
    fields.driver === 'redis' &&
    fields.redisMode !== 'standalone' &&
    parseNodes(fields.redisNodes).invalid &&
    !problems.includes('redis-node-invalid')
  ) {
    problems.push('redis-node-invalid');
  }
  if (
    fields.driver === 'mongodb' &&
    fields.mongoMode === 'replicaSet' &&
    parseNodes(fields.mongoNodes).invalid &&
    !problems.includes('mongo-node-invalid')
  ) {
    problems.push('mongo-node-invalid');
  }
  if (!isFileDriver(fields.driver) && fields.useSsh && sshAllowed(fields)) {
    for (const hop of [...fields.jumps, fields.ssh]) {
      for (const problem of hopProblemsOf(hop)) {
        if (!problems.includes(problem)) {
          problems.push(problem);
        }
      }
    }
  }
  return problems;
}

/** Message key per problem, so the form shows a translated line. */
export const PROBLEM_MESSAGES: Readonly<Record<ConnectionProblem, MessageKey>> = {
  'name-empty': 'form.error.nameEmpty',
  'host-empty': 'form.error.hostEmpty',
  'port-invalid': 'form.error.portInvalid',
  'file-empty': 'form.error.fileEmpty',
  'ssh-host-empty': 'form.error.hostEmpty',
  'ssh-port-invalid': 'form.error.portInvalid',
  'ssh-user-empty': 'form.ssh.error.userEmpty',
  'ssh-key-empty': 'form.ssh.error.keyEmpty',
  'ssh-id-invalid': 'form.unknownError',
  'ssh-too-many-jumps': 'form.ssh.error.tooManyJumps',
  'ssl-cert-without-key': 'form.ssl.error.keyMissing',
  'ssl-key-without-cert': 'form.ssl.error.certMissing',
  'connect-timeout-invalid': 'form.options.error.connectTimeout',
  'query-timeout-invalid': 'form.options.error.queryTimeout',
  'keep-alive-invalid': 'form.options.error.keepAlive',
  'time-zone-invalid': 'form.options.error.timeZone',
  'charset-invalid': 'form.options.error.charset',
  'init-sql-too-long': 'form.options.error.initSql',
  'filter-too-long': 'form.filter.error.tooLong',
  'redis-master-empty': 'form.redis.error.masterEmpty',
  'redis-node-invalid': 'form.redis.error.nodeInvalid',
  'redis-too-many-nodes': 'form.redis.error.tooManyNodes',
  'redis-database-invalid': 'form.redis.error.database',
  'redis-cluster-database': 'form.redis.error.clusterDatabase',
  'redis-ssh-topology': 'form.redis.error.ssh',
  'mongo-node-invalid': 'form.redis.error.nodeInvalid',
  'mongo-too-many-nodes': 'form.mongo.error.tooManyNodes',
  'mongo-srv-port': 'form.mongo.error.srvPort',
  'mongo-name-invalid': 'form.mongo.error.name',
  'mongo-ssh-topology': 'form.mongo.error.ssh',
  'elastic-prefix-invalid': 'form.elastic.error.prefix',
};

export { DEFAULT_SSH_PORT };

export function problemMessage(
  problems: readonly ConnectionProblem[],
  problem: ConnectionProblem,
): MessageKey | undefined {
  return problems.includes(problem) ? PROBLEM_MESSAGES[problem] : undefined;
}

/**
 * Fills the fields from a parsed URL. The URL describes the whole target, so fields it
 * leaves out are cleared; the name is kept when the user already gave one, and SSH
 * settings are left alone (a URL cannot carry them).
 */
export function applyUrl(fields: FormFields, parsed: ParsedConnectionUrl): void {
  const { input, password } = parsed;
  fields.driver = input.driver;
  fields.host = input.host ?? '';
  fields.port = input.port === undefined ? '' : String(input.port);
  fields.user = input.user ?? '';
  fields.database = input.database ?? '';
  fields.file = input.file ?? '';
  if (fields.name.trim() === '') {
    fields.name = input.name;
  }
  fields.sslMode = input.ssl?.mode ?? 'off';
  fields.sslCa = input.ssl?.ca ?? '';
  fields.sslCert = input.ssl?.cert ?? '';
  fields.sslKey = input.ssl?.key ?? '';
  // A Redis URL names one server; a MongoDB one may name a replica set or an SRV record.
  fields.redisMode = 'standalone';
  Object.assign(fields, mongoFieldsFrom(input));
  fields.elasticAuth = input.elastic?.auth ?? 'basic';
  fields.elasticPrefix = input.elastic?.pathPrefix ?? '';
  if (password !== undefined) {
    fields.password = password;
    fields.passwordTouched = true;
    fields.erasePassword = false;
  }
}

export const URL_PROBLEM_MESSAGES: Readonly<Record<UrlProblem, MessageKey>> = {
  'not-a-url': 'form.url.error.notUrl',
  'unknown-scheme': 'form.url.error.scheme',
  'no-host': 'form.error.hostEmpty',
  'no-file': 'form.error.fileEmpty',
};

/**
 * Starts a connection to a server that speaks MySQL's or PostgreSQL's protocol (V6.5):
 * its driver and port, and its usual account, database and TLS where the user has not
 * typed their own.
 */
export function applyPreset(fields: FormFields, preset: ServerPreset): void {
  fields.driver = preset.driver;
  fields.port = String(preset.port);
  if (fields.user.trim() === '' && preset.user !== undefined) {
    fields.user = preset.user;
  }
  if (fields.database.trim() === '' && preset.database !== undefined) {
    fields.database = preset.database;
  }
  if (fields.sslMode === 'off' && preset.ssl !== undefined) {
    fields.sslMode = preset.ssl;
  }
}
