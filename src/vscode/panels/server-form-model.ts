// What the server form does with the store and the SFTP hub (V13.37), without `vscode`, so
// the rules are unit-tested: the state the page starts with, what "Test" logs in with, and how
// a save turns the page's secrets into the store's.

import type { PasswordChange, SshSecretChanges } from '../../services/connection-store';
import type { SftpHub } from '../../services/sftp-hub';
import type { ServerStore } from '../../services/server-store';
import type { SshHopSecrets } from '../../shared/connection';
import type { ServerDraft, ServerFormState } from '../../shared/protocols/server-form';
import { type SshServerInput, serverHops } from '../../shared/ssh-server';
import { secretsForTest, storedSshFlags, toChange, toSshChanges } from './connection-form-state';

export interface ServerFormModelDeps {
  readonly store: Pick<
    ServerStore,
    'add' | 'update' | 'get' | 'getSshSecrets' | 'getProxyPassword'
  >;
  readonly hub: Pick<SftpHub, 'probe' | 'disconnect'>;
}

/** The change of the proxy's password the page asked for; a page that says nothing keeps it. */
export function proxyChangeOf(draft: Pick<ServerDraft, 'proxyPassword'>): PasswordChange {
  return draft.proxyPassword === undefined ? { kind: 'keep' } : toChange(draft.proxyPassword);
}

/** The proxy password to log in with: what was typed, else what is saved. */
export function proxyPasswordForTest(
  draft: Pick<ServerDraft, 'proxyPassword'>,
  saved: string | undefined,
): string | undefined {
  const change = proxyChangeOf(draft);
  switch (change.kind) {
    case 'set':
      return change.value === '' ? undefined : change.value;
    case 'clear':
      return undefined;
    case 'keep':
      return saved;
  }
}

/** The secrets a new server is saved with: only what was typed, a hop's unused method's none. */
export function newSecrets(draft: ServerDraft): Record<string, SshHopSecrets> {
  return secretsForTest(toSshChanges(draft), serverHops(draft.input), {});
}

export class ServerFormModel {
  constructor(
    private readonly deps: ServerFormModelDeps,
    private serverId?: string,
  ) {}

  get id(): string | undefined {
    return this.serverId;
  }

  /** The name the editor tab wears, empty for a server that is not saved yet. */
  get name(): string {
    return this.serverId === undefined ? '' : (this.deps.store.get(this.serverId)?.name ?? '');
  }

  async state(): Promise<ServerFormState> {
    const config = this.serverId === undefined ? undefined : this.deps.store.get(this.serverId);
    if (config === undefined) {
      return { storedSsh: [] };
    }
    const { id: serverId, ...input } = config;
    const saved = await this.deps.store.getSshSecrets(serverId);
    const hasProxyPassword = (await this.deps.store.getProxyPassword(serverId)) !== undefined;
    return {
      serverId,
      input: dropUndefined(input),
      storedSsh: storedSshFlags(saved),
      ...(hasProxyPassword ? { hasStoredProxyPassword: true } : {}),
    };
  }

  /** Logs in with the draft; a saved password the page did not retype is used as it is. */
  async test(draft: ServerDraft): Promise<{ home: string; hops: number }> {
    const saved =
      this.serverId === undefined ? {} : await this.deps.store.getSshSecrets(this.serverId);
    const savedProxy =
      this.serverId === undefined
        ? undefined
        : await this.deps.store.getProxyPassword(this.serverId);
    const secrets = secretsForTest(toSshChanges(draft), serverHops(draft.input), saved);
    return await this.deps.hub.probe(
      draft.input,
      secrets,
      draft.input.proxy === undefined ? undefined : proxyPasswordForTest(draft, savedProxy),
    );
  }

  /** Adds the server, or updates the one being edited; the open session is closed first. */
  async save(draft: ServerDraft): Promise<string> {
    if (this.serverId === undefined) {
      const proxy = proxyPasswordForTest(draft, undefined);
      const added = await this.deps.store.add(draft.input, newSecrets(draft), proxy);
      this.serverId = added.id;
      return added.id;
    }
    // The saved login must not outlive the settings it was made for.
    this.deps.hub.disconnect(this.serverId);
    const changes: SshSecretChanges = toSshChanges(draft);
    await this.deps.store.update(this.serverId, draft.input, changes, proxyChangeOf(draft));
    return this.serverId;
  }
}

/** The store keeps cleared optional fields as `undefined` keys, which the page's schema sees. */
function dropUndefined(input: SshServerInput): SshServerInput {
  const entries: [string, unknown][] = Object.entries(input);
  const kept = entries.filter(([, value]) => value !== undefined);
  return Object.fromEntries(kept) as unknown as SshServerInput;
}
