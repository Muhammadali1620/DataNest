// Small helpers of the ZooKeeper znode page (V13.24), apart from the component so they are
// tested on their own.

import type { ZnodeAclEntry } from '../../../../src/shared/protocols/zookeeper-node';

/** The badge colour class of each kind of znode. */
export const KIND_TONE: Readonly<Record<'persistent' | 'ephemeral' | 'container' | 'ttl', string>> =
  {
    persistent: 'persistent',
    ephemeral: 'ephemeral',
    container: 'container',
    ttl: 'ttl',
  };

/** `world:anyone`, `digest:user:hash`, `auth:` — the entry's scheme and id. */
export function aclText(entry: ZnodeAclEntry): string {
  return entry.id === '' ? `${entry.scheme}:` : `${entry.scheme}:${entry.id}`;
}

/** A time in milliseconds since the epoch as the reader's locale writes it; `—` for none. */
export function timeText(milliseconds: number, locale?: string): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '—';
  }
  return new Date(milliseconds).toLocaleString(locale);
}

/** `14:03:09`: the time of day a change was seen, in the viewer's time zone. */
export function clockTime(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}
