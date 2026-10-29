// The server's own report (`INFO`, V7.4) as sections of fields, and the few numbers a
// person looks at first: version, uptime, clients, memory, operations per second, hit
// rate and keys.

import type { RedisSession } from '../../drivers/redis-driver';
import { parseKeyspace } from './redis-databases';
import { replyText } from './reply';

export interface InfoSection {
  /** `Server`, `Clients`, `Memory`, … as the server names them. */
  readonly name: string;
  readonly fields: readonly (readonly [string, string])[];
}

/** `# Server` headers and `name:value` lines; anything else is skipped. */
export function parseInfo(text: string): InfoSection[] {
  const sections: { name: string; fields: [string, string][] }[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#')) {
      sections.push({ name: line.slice(1).trim(), fields: [] });
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    if (sections.length === 0) {
      sections.push({ name: '', fields: [] });
    }
    sections.at(-1)?.fields.push([line.slice(0, colon), line.slice(colon + 1)]);
  }
  return sections;
}

export interface InfoSummary {
  readonly version?: string;
  /** `standalone`, `sentinel` or `cluster`. */
  readonly mode?: string;
  readonly role?: string;
  readonly uptimeSeconds?: number;
  readonly clients?: number;
  readonly usedMemory?: number;
  readonly peakMemory?: number;
  /** 0 means no limit. */
  readonly maxMemory?: number;
  readonly opsPerSecond?: number;
  /** Share of key lookups that found the key, 0…1; absent before the first lookup. */
  readonly hitRate?: number;
  readonly keys: number;
}

export function summarize(sections: readonly InfoSection[]): InfoSummary {
  const fields = new Map(sections.flatMap((section) => section.fields));
  const number = (name: string): number | undefined => {
    const value = fields.get(name);
    if (value === undefined || value.trim() === '') {
      return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const text = (name: string): string | undefined => fields.get(name);
  const hits = number('keyspace_hits');
  const misses = number('keyspace_misses');
  const lookups = (hits ?? 0) + (misses ?? 0);
  const keyspace = sections.find((section) => section.name.toLowerCase() === 'keyspace');
  const keys =
    keyspace === undefined
      ? 0
      : [
          ...parseKeyspace(
            keyspace.fields.map(([name, value]) => `${name}:${value}`).join('\n'),
          ).values(),
        ].reduce((sum, database) => sum + database.keys, 0);
  const entries: [keyof InfoSummary, string | number | undefined][] = [
    ['version', text('redis_version') ?? text('valkey_version')],
    ['mode', text('redis_mode') ?? text('server_mode')],
    ['role', text('role')],
    ['uptimeSeconds', number('uptime_in_seconds')],
    ['clients', number('connected_clients')],
    ['usedMemory', number('used_memory')],
    ['peakMemory', number('used_memory_peak')],
    ['maxMemory', number('maxmemory')],
    ['opsPerSecond', number('instantaneous_ops_per_sec')],
    ['hitRate', lookups === 0 ? undefined : (hits ?? 0) / lookups],
  ];
  return {
    ...Object.fromEntries(entries.filter(([, value]) => value !== undefined)),
    keys,
  };
}

export interface ServerInfoNode {
  readonly name: string;
  readonly sections: InfoSection[];
  readonly summary: InfoSummary;
}

/** INFO of the server, or of each master of a cluster, named by `nameOf`. */
export async function readServerInfo(
  session: RedisSession,
  nameOf: (index: number, count: number) => string,
): Promise<ServerInfoNode[]> {
  const replies = await session.onMasters(['INFO']);
  return replies.map((reply, index) => {
    const sections = parseInfo(replyText(reply));
    return { name: nameOf(index, replies.length), sections, summary: summarize(sections) };
  });
}
