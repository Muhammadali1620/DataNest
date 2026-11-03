// Pure form logic: what the user typed → what the host receives, and which
// problems block saving. Kept apart from the component so it is tested directly.

import type { ServerChoice } from '../../../../src/shared/protocols/connection-form';
import {
  effectiveProxyPort,
  type ProxyKind,
  type ProxySettings,
  supportsSocket,
  type ConnectionColor,
  type ConnectionInput,
  type ConnectionProblem,
  connectionProblems,
  DEFAULT_PROXY_PORTS,
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
  type KafkaRegistryAuth,
  type KafkaSaslMechanism,
  type KafkaSettings,
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
import { cleanAlgorithms, type SshAlgorithmKind } from '../../../../src/shared/ssh-algorithms';
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
  /** One rule per kind, in OpenSSH's syntax (V13.10); blank keeps the defaults. */
  algorithms: Record<SshAlgorithmKind, string>;
}

/** Blank rules for every kind of algorithm. */
export function emptyAlgorithmFields(): Record<SshAlgorithmKind, string> {
  return { kex: '', serverHostKey: '', cipher: '', hmac: '', compress: '' };
}

export function newHopFields(id: string = newHopId()): HopFields {
  return {
    id,
    host: '',
    // The usual port is already typed; whoever's server listens elsewhere changes it (V15.1).
    port: String(DEFAULT_SSH_PORT),
    user: '',
    auth: 'password',
    keyFile: '',
    agentSocket: '',
    password: emptySecret(),
    passphrase: emptySecret(),
    algorithms: emptyAlgorithmFields(),
  };
}

export function hopFieldsFrom(hop: SshHop): HopFields {
  return {
    id: hop.id,
    host: hop.host,
    port: String(hop.port ?? DEFAULT_SSH_PORT),
    user: hop.user,
    auth: hop.auth,
    keyFile: hop.keyFile ?? '',
    agentSocket: hop.agentSocket ?? '',
    password: emptySecret(),
    passphrase: emptySecret(),
    algorithms: { ...emptyAlgorithmFields(), ...hop.algorithms },
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
  /** A SQLite file on a server may be changed there (V13.33); needs SSH. */
  remoteWrite: boolean;
  /** Key of the project whose file keeps the connection; empty for the user's own list. */
  project: string;
  /** Session options (V4.9), as typed; seconds stay text until they are checked. */
  connectTimeout: string;
  queryTimeout: string;
  keepAlive: string;
  /** ZooKeeper (V13.27): the lifetime of the session, in seconds. */
  sessionTimeout: string;
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
  /** Kafka (V13.23): how the brokers want a user to sign in. */
  kafkaSasl: KafkaSaslMechanism;
  /** The address of a schema registry (V13.34); empty: none. */
  kafkaRegistry: string;
  /** How the registry is signed in to (V13.41): the connection's login, or one of its own. */
  kafkaRegistryAuth: KafkaRegistryAuth;
  /** The registry's own user, for `basic`. */
  kafkaRegistryUser: string;
  /** The registry's own password, or its token for `bearer`; kept in SecretStorage. */
  kafkaRegistrySecret: SecretField;
  /** A Unix socket instead of host and port (V10.2.5); MySQL, PostgreSQL, Redis. */
  socket: string;
  /** Connect through a proxy (V10.2.5); its fields are kept while it is off. */
  useProxy: boolean;
  proxyKind: ProxyKind;
  proxyHost: string;
  proxyPort: string;
  proxyUser: string;
  proxyPassword: SecretField;
}

/** The option fields that hold seconds, with the problem a bad number gives. */
const SECOND_FIELDS = [
  ['connectTimeout', 'connect-timeout-invalid'],
  ['queryTimeout', 'query-timeout-invalid'],
  ['keepAlive', 'keep-alive-invalid'],
  ['sessionTimeout', 'session-timeout-invalid'],
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
    remoteWrite: input.remoteWrite === true,
    project: state.project?.key ?? '',
    connectTimeout: secondsText(input.options?.connectTimeout),
    queryTimeout: secondsText(input.options?.queryTimeout),
    keepAlive: secondsText(input.options?.keepAlive),
    sessionTimeout: secondsText(input.options?.sessionTimeout),
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
    kafkaSasl: input.kafka?.sasl ?? 'none',
    kafkaRegistry: input.kafka?.registry ?? '',
    kafkaRegistryAuth: input.kafka?.registryAuth ?? 'connection',
    kafkaRegistryUser: input.kafka?.registryUser ?? '',
    kafkaRegistrySecret: emptySecret(),
    socket: input.socket ?? '',
    useProxy: input.proxy !== undefined,
    proxyKind: input.proxy?.kind ?? 'socks5',
    proxyHost: input.proxy?.host ?? '',
    proxyPort: String(input.proxy?.port ?? DEFAULT_PROXY_PORTS[input.proxy?.kind ?? 'socks5']),
    proxyUser: input.proxy?.user ?? '',
    proxyPassword: emptySecret(),
  };
}

/** The proxy to send, when one is on (V10.2.5). */
export function toProxy(fields: FormFields): ProxySettings | undefined {
  if (!fields.useProxy || isFileDriver(fields.driver)) {
    return undefined;
  }
  const typed = parsePort(fields.proxyPort);
  const port = typed === DEFAULT_PROXY_PORTS[fields.proxyKind] ? undefined : typed;
  const user = trim(fields.proxyUser);
  return {
    kind: fields.proxyKind,
    host: fields.proxyHost.trim(),
    ...(port === undefined ? {} : { port }),
    ...(user === undefined ? {} : { user }),
  };
}

/** The Kafka settings to send; none when the brokers ask for no SASL and no registry is set. */
export function toKafka(fields: FormFields): KafkaSettings | undefined {
  if (fields.driver !== 'kafka') {
    return undefined;
  }
  const registry = fields.kafkaRegistry.trim();
  if (fields.kafkaSasl === 'none' && registry === '') {
    return undefined;
  }
  // The registry's own sign-in means something only with a registry.
  const auth = registry === '' ? 'connection' : fields.kafkaRegistryAuth;
  const user = auth === 'basic' ? fields.kafkaRegistryUser.trim() : '';
  return {
    sasl: fields.kafkaSasl,
    ...(registry === '' ? {} : { registry }),
    ...(auth === 'connection' ? {} : { registryAuth: auth }),
    ...(auth === 'basic' ? { registryUser: user } : {}),
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
    sessionTimeout: support.sessionTimeout === true,
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
  // The usual port is typed into the box, but a hop on it is saved without one (V15.1).
  const typed = parsePort(hop.port);
  const port = typed === DEFAULT_SSH_PORT ? undefined : typed;
  const keyFile = hop.auth === 'key' ? trim(hop.keyFile) : undefined;
  const agentSocket = hop.auth === 'agent' ? trim(hop.agentSocket) : undefined;
  const algorithms = cleanAlgorithms(hop.algorithms);
  return {
    id: hop.id,
    host: hop.host.trim(),
    ...(port === undefined ? {} : { port }),
    user: hop.user.trim(),
    auth: hop.auth,
    ...(keyFile === undefined ? {} : { keyFile }),
    ...(agentSocket === undefined ? {} : { agentSocket }),
    ...(algorithms === undefined ? {} : { algorithms }),
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
      // The file is on a server that SSH leads to (V12.8).
      ...(fields.useSsh
        ? {
            ssh: {
              ...toHop(fields.ssh),
              ...(fields.jumps.length === 0 ? {} : { jumps: fields.jumps.map(toHop) }),
            },
          }
        : {}),
      ...(fields.useSsh && fields.remoteWrite && !fields.readOnly ? { remoteWrite: true } : {}),
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
  const kafka = toKafka(fields);
  const socket = supportsSocket(fields.driver) ? trim(fields.socket) : undefined;
  const proxy = toProxy(fields);
  // An API key signs in alone: a user name would only confuse the server.
  const signsWithKey = elastic?.auth === 'apiKey';
  return {
    name,
    driver: fields.driver,
    ...(host === undefined ? {} : { host }),
    ...(port === undefined ? {} : { port }),
    ...(user === undefined || signsWithKey ? {} : { user }),
    ...(database === undefined || fields.driver === 'elasticsearch' || fields.driver === 'kafka'
      ? {}
      : { database }),
    ...(fields.useSsh && sshAllowed(fields)
      ? {
          ssh: {
            ...toHop(fields.ssh),
            ...(fields.jumps.length === 0 ? {} : { jumps: fields.jumps.map(toHop) }),
          },
        }
      : {}),
    ...(socket === undefined ? {} : { socket }),
    ...(proxy === undefined ? {} : { proxy }),
    ...(ssl === undefined ? {} : { ssl }),
    ...arrangement(fields),
    ...(options === undefined ? {} : { options }),
    ...(filter === undefined ? {} : { filter }),
    ...(redis === undefined ? {} : { redis }),
    ...(mongo === undefined ? {} : { mongo }),
    ...(elastic === undefined ? {} : { elastic }),
    ...(kafka === undefined ? {} : { kafka }),
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

/**
 * Where a hop or the proxy was filled from a saved server (V15.1): by the id of the hop in
 * the form, and for the proxy by the server's id. Only ids; the secrets stay in the host.
 */
export interface ServerLinks {
  hops: Record<string, { serverId: string; hopId: string }>;
  proxy?: string;
}

/** The port a proxy of another kind starts with, unless the user has typed their own. */
export function proxyPortAfterKind(from: ProxyKind, to: ProxyKind, port: string): string {
  const text = port.trim();
  return text === '' || text === String(DEFAULT_PROXY_PORTS[from])
    ? String(DEFAULT_PROXY_PORTS[to])
    : port;
}

/** A hop of a saved server as the form edits it: a copy under an id of its own. */
export function hopFieldsFromServer(hop: SshHop): HopFields {
  return { ...hopFieldsFrom(hop), id: newHopId() };
}

function forgetLinks(links: ServerLinks, hops: readonly HopFields[]): void {
  const gone = new Set(hops.map((hop) => hop.id));
  links.hops = Object.fromEntries(Object.entries(links.hops).filter(([id]) => !gone.has(id)));
}

/** Fills the tunnel from a saved server: its login, jump hosts and, if asked, its proxy. */
export function applyServer(
  fields: FormFields,
  links: ServerLinks,
  choice: ServerChoice,
  withProxy: boolean,
): void {
  const { server } = choice;
  forgetLinks(links, [fields.ssh, ...fields.jumps]);
  const link = (copy: HopFields, hopId: string): HopFields => {
    links.hops[copy.id] = { serverId: server.id, hopId };
    return copy;
  };
  const { jumps = [], ...own } = server.ssh;
  fields.ssh = link(hopFieldsFromServer(own), own.id);
  fields.jumps = jumps.map((jump) => link(hopFieldsFromServer(jump), jump.id));
  if (withProxy && server.proxy !== undefined) {
    fields.useProxy = true;
    fields.proxyKind = server.proxy.kind;
    fields.proxyHost = server.proxy.host;
    fields.proxyPort = String(effectiveProxyPort(server.proxy));
    fields.proxyUser = server.proxy.user ?? '';
    fields.proxyPassword = emptySecret();
    links.proxy = server.id;
  }
}

/** Fills one jump host with the login of a saved server (its own hop, not its jumps). */
export function applyServerToJump(
  fields: FormFields,
  links: ServerLinks,
  index: number,
  choice: ServerChoice,
): void {
  const old = fields.jumps[index];
  if (old === undefined) {
    return;
  }
  forgetLinks(links, [old]);
  const { jumps: _unused, ...own } = choice.server.ssh;
  const copy = hopFieldsFromServer(own);
  links.hops[copy.id] = { serverId: choice.server.id, hopId: own.id };
  fields.jumps[index] = copy;
}

/** The flags of a hop's secrets in the saved server it was filled from, if it was. */
export function serverStoredFor(
  links: ServerLinks,
  servers: readonly ServerChoice[] | undefined,
  hopId: string,
): { password: boolean; passphrase: boolean } | undefined {
  const link = links.hops[hopId];
  if (link === undefined) {
    return undefined;
  }
  const found = servers
    ?.find((choice) => choice.server.id === link.serverId)
    ?.storedSsh.find((entry) => entry.hopId === link.hopId);
  return { password: found?.password ?? false, passphrase: found?.passphrase ?? false };
}

export function toDraft(fields: FormFields, links?: ServerLinks): ConnectionDraft {
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
      : {
          ssh: [...fields.jumps, fields.ssh].map((hop) => {
            const fromServer = links?.hops[hop.id];
            return {
              ...hopSecretChanges(hop),
              ...(fromServer === undefined ? {} : { fromServer }),
            };
          }),
        }),
    // Only a registry with a sign-in of its own has the secret; the store drops it otherwise.
    ...(input.kafka?.registryAuth === 'basic' || input.kafka?.registryAuth === 'bearer'
      ? { registrySecret: secretChange(fields.kafkaRegistrySecret) }
      : {}),
    // Without a proxy the store drops its password by itself.
    ...(input.proxy === undefined ? {} : { proxyPassword: secretChange(fields.proxyPassword) }),
    ...(input.proxy === undefined || links?.proxy === undefined
      ? {}
      : { proxyFromServer: links.proxy }),
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
  const proxyPort = fields.proxyPort.trim();
  if (
    fields.useProxy &&
    proxyPort !== '' &&
    parsePort(proxyPort) === undefined &&
    !problems.includes('proxy-port-invalid')
  ) {
    problems.push('proxy-port-invalid');
  }
  if (fields.useSsh && sshAllowed(fields)) {
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
  'plugin-invalid': 'form.driver.plugin',
  'ssh-host-empty': 'form.error.hostEmpty',
  'ssh-port-invalid': 'form.error.portInvalid',
  'ssh-user-empty': 'form.ssh.error.userEmpty',
  'ssh-key-empty': 'form.ssh.error.keyEmpty',
  'ssh-id-invalid': 'form.unknownError',
  'ssh-too-many-jumps': 'form.ssh.error.tooManyJumps',
  'ssh-algorithms-invalid': 'form.ssh.error.algorithms',
  'ssl-cert-without-key': 'form.ssl.error.keyMissing',
  'ssl-key-without-cert': 'form.ssl.error.certMissing',
  'connect-timeout-invalid': 'form.options.error.connectTimeout',
  'query-timeout-invalid': 'form.options.error.queryTimeout',
  'keep-alive-invalid': 'form.options.error.keepAlive',
  'session-timeout-invalid': 'form.options.error.sessionTimeout',
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
  'kafka-registry-invalid': 'form.kafka.error.registry',
  'kafka-registry-user-missing': 'form.kafka.error.registryUser',
  'socket-unsupported': 'form.socket.error.unsupported',
  'socket-with-tunnel': 'form.socket.error.tunnel',
  'proxy-host-empty': 'form.error.hostEmpty',
  'proxy-port-invalid': 'form.error.portInvalid',
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
  fields.kafkaSasl = input.kafka?.sasl ?? 'none';
  fields.kafkaRegistry = input.kafka?.registry ?? '';
  fields.kafkaRegistryAuth = input.kafka?.registryAuth ?? 'connection';
  fields.kafkaRegistryUser = input.kafka?.registryUser ?? '';
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
