// MongoDB connection strings (V7.5): `mongodb://user:pass@host1:27017,host2/db?replicaSet=rs0`
// and `mongodb+srv://user:pass@cluster0.example.net/db`. A seed list is not a URL the
// URL parser accepts, so it is read here by hand.

import type {
  ConnectionInput,
  MongoAuthMechanism,
  MongoSettings,
  NodeAddress,
  SslSettings,
} from './connection';
import { MONGO_AUTH_MECHANISMS } from './connection';

/** What a MongoDB URL holds; the password is kept apart, as for other URLs. */
export type MongoUrlResult =
  | {
      readonly ok: true;
      readonly value: { readonly input: ConnectionInput; readonly password?: string };
    }
  | { readonly ok: false; readonly problem: 'not-a-url' | 'no-host' };

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function nonEmpty(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

/** `host`, `host:27017`, `[::1]:27017`; undefined when the port is not a port. */
function address(text: string): NodeAddress | undefined {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d*))?$/.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const host = decode(match[1] ?? '').replace(/^\[(.*)\]$/, '$1');
  const portText = match[2];
  if (portText === undefined || portText === '') {
    return host === '' ? undefined : { host };
  }
  const port = Number(portText);
  return host === '' || port < 1 || port > 65_535 ? undefined : { host, port };
}

function isTrue(value: string | undefined): boolean {
  return value !== undefined && /^(true|1|yes)$/i.test(value);
}

/** TLS as the options ask for it; an SRV record means TLS when they say nothing. */
function tlsOf(params: URLSearchParams, srv: boolean): SslSettings | undefined {
  const get = (name: string): string | undefined => {
    for (const [key, value] of params) {
      if (key.toLowerCase() === name.toLowerCase()) {
        return nonEmpty(value);
      }
    }
    return undefined;
  };
  const flag = get('tls') ?? get('ssl');
  const on = flag === undefined ? srv : isTrue(flag);
  if (!on) {
    return undefined;
  }
  const insecure =
    isTrue(get('tlsInsecure')) ||
    isTrue(get('tlsAllowInvalidCertificates')) ||
    isTrue(get('sslAllowInvalidCertificates'));
  const anyHost =
    isTrue(get('tlsAllowInvalidHostnames')) || isTrue(get('sslAllowInvalidHostnames'));
  const ca = get('tlsCAFile') ?? get('sslCA');
  // One PEM file with the certificate and its key: Node finds each in it.
  const pair = get('tlsCertificateKeyFile') ?? get('sslPEMKeyFile');
  return {
    mode: insecure ? 'require' : anyHost ? 'verify-ca' : 'verify-full',
    ...(ca === undefined ? {} : { ca: decode(ca) }),
    ...(pair === undefined ? {} : { cert: decode(pair), key: decode(pair) }),
  };
}

function mechanismOf(text: string | undefined): MongoAuthMechanism | undefined {
  const upper = text?.toUpperCase();
  return MONGO_AUTH_MECHANISMS.find((mechanism) => mechanism === upper);
}

/** True for `mongodb://…` and `mongodb+srv://…`. */
export function isMongoUrl(text: string): boolean {
  return /^\s*mongodb(\+srv)?:\/\//i.test(text);
}

export function parseMongoUrl(text: string): MongoUrlResult {
  const match = /^\s*mongodb(\+srv)?:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#.*)?\s*$/i.exec(
    text,
  );
  if (match === null) {
    return { ok: false, problem: 'not-a-url' };
  }
  const srv = match[1] !== undefined;
  const authority = match[2] ?? '';
  // The password may hold an `@` written as is; the last one ends the credentials.
  const at = authority.lastIndexOf('@');
  const credentials = at < 0 ? '' : authority.slice(0, at);
  const hostsText = at < 0 ? authority : authority.slice(at + 1);
  const colon = credentials.indexOf(':');
  const user = nonEmpty(decode(colon < 0 ? credentials : credentials.slice(0, colon)));
  const password = colon < 0 ? undefined : decode(credentials.slice(colon + 1));
  const hosts = hostsText.split(',').filter((part) => part.trim() !== '');
  const addresses = hosts.map(address);
  const [first, ...others] = addresses;
  if (hosts.length === 0) {
    return { ok: false, problem: 'no-host' };
  }
  // A port that is not a port makes the whole URL unreadable.
  if (first === undefined || addresses.some((one) => one === undefined)) {
    return { ok: false, problem: 'not-a-url' };
  }
  const params = new URLSearchParams(match[4] ?? '');
  const param = (name: string): string | undefined => {
    for (const [key, value] of params) {
      if (key.toLowerCase() === name.toLowerCase()) {
        return nonEmpty(value);
      }
    }
    return undefined;
  };
  const database = nonEmpty(decode(match[3] ?? ''));
  const replicaSet = param('replicaSet');
  const direct = isTrue(param('directConnection'));
  const mode: MongoSettings['mode'] = srv
    ? 'srv'
    : !direct && (others.length > 0 || replicaSet !== undefined)
      ? 'replicaSet'
      : 'direct';
  const authSource = param('authSource');
  const authMechanism = mechanismOf(param('authMechanism'));
  const nodes = others.filter((node): node is NodeAddress => node !== undefined);
  const mongo: MongoSettings = {
    mode,
    ...(mode === 'replicaSet' && replicaSet !== undefined ? { replicaSet } : {}),
    ...(mode === 'replicaSet' && nodes.length > 0 ? { nodes } : {}),
    ...(authSource === undefined ? {} : { authSource }),
    ...(authMechanism === undefined ? {} : { authMechanism }),
  };
  const ssl = tlsOf(params, srv);
  const input: ConnectionInput = {
    name: database ?? first.host,
    driver: 'mongodb',
    host: first.host,
    ...(srv || first.port === undefined ? {} : { port: first.port }),
    ...(user === undefined ? {} : { user }),
    ...(database === undefined ? {} : { database }),
    ...(ssl === undefined ? {} : { ssl }),
    // A plain single server needs no settings of its own.
    ...(mode === 'direct' && authSource === undefined && authMechanism === undefined
      ? {}
      : { mongo }),
  };
  return {
    ok: true,
    value: { input, ...(password === undefined || password === '' ? {} : { password }) },
  };
}
