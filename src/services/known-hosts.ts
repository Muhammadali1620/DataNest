// SSH servers the user has trusted, by host, port and key type. The first
// connection asks; a changed key afterwards is refused unless the user replaces it,
// the way OpenSSH treats known_hosts.

import type { Logger } from '../core/logging/logger';
import { array, literal, number, object, string } from '../shared/schema';
import type { KeyValueState } from './connection-store';
import type { HostKeyInfo } from './tunnels';

export const KNOWN_HOSTS_STATE_KEY = 'ssh.knownHosts';

export type HostKeyStatus = 'trusted' | 'unknown' | 'changed';

const entrySchema = object({
  host: string({ maxLength: 500 }),
  port: number({ integer: true, min: 1, max: 65_535 }),
  algorithm: string({ maxLength: 100 }),
  fingerprint: string({ maxLength: 200 }),
});

const stateSchema = object({
  version: literal(1),
  items: array(entrySchema, { maxLength: 10_000 }),
});

type Entry = Readonly<HostKeyInfo>;

function sameServer(a: Entry, b: Entry): boolean {
  // Host names are case-insensitive; the same server under another name is new.
  return (
    a.host.toLowerCase() === b.host.toLowerCase() &&
    a.port === b.port &&
    a.algorithm === b.algorithm
  );
}

export class KnownHosts {
  private items: Entry[];

  constructor(
    private readonly state: KeyValueState,
    private readonly logger: Logger,
  ) {
    this.items = this.load();
  }

  status(key: HostKeyInfo): HostKeyStatus {
    const known = this.items.find((item) => sameServer(item, key));
    if (known === undefined) {
      return 'unknown';
    }
    return known.fingerprint === key.fingerprint ? 'trusted' : 'changed';
  }

  /** The fingerprint trusted before for this server and key type, if any. */
  previous(key: HostKeyInfo): string | undefined {
    return this.items.find((item) => sameServer(item, key))?.fingerprint;
  }

  /** Trusts the key, replacing whatever was trusted for this server and key type. */
  async trust(key: HostKeyInfo): Promise<void> {
    const entry: Entry = {
      host: key.host,
      port: key.port,
      algorithm: key.algorithm,
      fingerprint: key.fingerprint,
    };
    const items = [...this.items.filter((item) => !sameServer(item, key)), entry];
    await this.state.update(KNOWN_HOSTS_STATE_KEY, { version: 1, items });
    this.items = items;
  }

  private load(): Entry[] {
    const raw = this.state.get(KNOWN_HOSTS_STATE_KEY);
    if (raw === undefined) {
      return [];
    }
    try {
      return stateSchema.parse(raw).items;
    } catch (error) {
      // Forgetting trusted keys only means asking again; never trust on broken state.
      this.logger.error('Trusted SSH host keys are corrupted and were ignored', error);
      return [];
    }
  }
}
