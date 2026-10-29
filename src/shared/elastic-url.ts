// Elasticsearch connection URLs (V7.8): `elasticsearch://user:pass@host:9200`, with
// `+https` (or `ssl=true`) for TLS, `opensearch://` and `es://` alike; and the plain
// `https://…:9243` that apps keep in ELASTICSEARCH_URL or OPENSEARCH_URL.

import type { ConnectionInput, SslSettings } from './connection';

export type ElasticUrlResult =
  | {
      readonly ok: true;
      readonly value: { readonly input: ConnectionInput; readonly password?: string };
    }
  | { readonly ok: false; readonly problem: 'not-a-url' | 'no-host' };

const SCHEME = /^\s*(?:elasticsearch|opensearch|es)(\+https?)?:\/\//i;

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** True for the URL schemes that name Elasticsearch themselves. */
export function isElasticUrl(text: string): boolean {
  return SCHEME.test(text);
}

/** Reads `http(s)://…` once the variable it came from says it is Elasticsearch. */
export function parseElasticHttpUrl(text: string): ElasticUrlResult {
  const match = /^\s*(https?):\/\//i.exec(text);
  if (match === null) {
    return { ok: false, problem: 'not-a-url' };
  }
  return parseElasticUrl(
    text.trim().replace(/^https?:/i, `elasticsearch+${match[1]?.toLowerCase() ?? 'http'}:`),
  );
}

export function parseElasticUrl(text: string): ElasticUrlResult {
  const scheme = SCHEME.exec(text);
  if (scheme === null) {
    return { ok: false, problem: 'not-a-url' };
  }
  let url: URL;
  try {
    url = new URL(text.trim().replace(/^[a-z+]+:/i, 'datanest:'));
  } catch {
    return { ok: false, problem: 'not-a-url' };
  }
  const host = decode(url.hostname).replace(/^\[(.*)\]$/, '$1');
  if (host === '') {
    return { ok: false, problem: 'no-host' };
  }
  const params = url.searchParams;
  const secure =
    scheme[1]?.toLowerCase() === '+https' ||
    /^(true|1)$/i.test(params.get('ssl') ?? params.get('tls') ?? '');
  const ssl: SslSettings | undefined = secure ? { mode: 'verify-full' } : undefined;
  const port = url.port === '' ? undefined : Number(url.port);
  const user = decode(url.username);
  const password = decode(url.password);
  const prefix = url.pathname.replace(/\/+$/, '');
  const input: ConnectionInput = {
    name: host,
    driver: 'elasticsearch',
    host,
    // An https URL without a port means 443, as the cloud services print them.
    ...(port === undefined ? (secure && scheme[1] !== undefined ? { port: 443 } : {}) : { port }),
    ...(user === '' ? {} : { user }),
    ...(ssl === undefined ? {} : { ssl }),
    ...(prefix === '' ? {} : { elastic: { auth: 'basic', pathPrefix: prefix } }),
  };
  return { ok: true, value: { input, ...(password === '' ? {} : { password }) } };
}
