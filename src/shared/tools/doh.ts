// DNS over HTTPS for the Tools page: the two public JSON endpoints and how their answers
// are read. Only the user's click starts a query, and the page says which server gets it.

export const DNS_TYPES = ['A', 'AAAA', 'MX', 'TXT', 'CNAME', 'NS'] as const;
export type DnsType = (typeof DNS_TYPES)[number];

export const DOH_PROVIDERS = ['cloudflare', 'google'] as const;
export type DohProvider = (typeof DOH_PROVIDERS)[number];

/** The host that receives the question, for the page to name. */
export const DOH_HOSTS: Readonly<Record<DohProvider, string>> = {
  cloudflare: 'cloudflare-dns.com',
  google: 'dns.google',
};

export function dohUrl(provider: DohProvider, name: string, type: DnsType): string {
  const query = `name=${encodeURIComponent(name)}&type=${type}`;
  return provider === 'cloudflare'
    ? `https://cloudflare-dns.com/dns-query?${query}`
    : `https://dns.google/resolve?${query}`;
}

export interface DnsRecord {
  readonly name: string;
  readonly type: string;
  readonly ttl: number;
  readonly data: string;
}

export type DohOutcome =
  | { readonly ok: true; readonly records: DnsRecord[] }
  | { readonly ok: false; readonly error: 'not-found' | 'failed' };

const TYPE_NAMES: Readonly<Record<number, string>> = {
  1: 'A',
  2: 'NS',
  5: 'CNAME',
  15: 'MX',
  16: 'TXT',
  28: 'AAAA',
};

/** TXT answers come quoted, possibly in several quoted pieces: `"a" "b"` → `ab`. */
function unquote(data: string): string {
  const pieces = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map((match) => match[1] ?? '');
  return pieces.length === 0 ? data : pieces.join('').replace(/\\(.)/gu, '$1');
}

/** Reads a `application/dns-json` answer; a name that does not exist is `not-found`. */
export function parseDohResponse(body: string): DohOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, error: 'failed' };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { ok: false, error: 'failed' };
  }
  const { Status: status, Answer: answer } = parsed as { Status?: unknown; Answer?: unknown };
  if (status === 3) {
    return { ok: false, error: 'not-found' };
  }
  if (status !== 0) {
    return { ok: false, error: 'failed' };
  }
  const records: DnsRecord[] = [];
  for (const entry of Array.isArray(answer) ? (answer as unknown[]) : []) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }
    const { name, type, TTL, data } = entry as Record<string, unknown>;
    if (typeof name !== 'string' || typeof type !== 'number' || typeof data !== 'string') {
      continue;
    }
    const typeName = TYPE_NAMES[type];
    if (typeName === undefined) {
      continue;
    }
    records.push({
      name: name.replace(/\.$/u, ''),
      type: typeName,
      ttl: typeof TTL === 'number' ? TTL : 0,
      data: typeName === 'TXT' ? unquote(data) : data.replace(/\.$/u, ''),
    });
  }
  return records.length === 0 ? { ok: false, error: 'not-found' } : { ok: true, records };
}
