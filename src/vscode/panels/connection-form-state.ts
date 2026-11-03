// Pure parts of the connection form panel: what the page is told about drivers and
// how its password choice maps onto the store. Kept free of `vscode` so unit tests
// can cover it (ARCHITECTURE.md §11).

import type { PasswordChange, SshSecretChanges } from '../../services/connection-store';
import {
  type ConnectionConfig,
  type ConnectionInput,
  DEFAULT_PORTS,
  DRIVER_IDS,
  isFileDriver,
  effectiveProxyPort,
  effectiveSshPort,
  type SshHop,
  type SshHopSecrets,
  sshHopsOf,
} from '../../shared/connection';
import { serverHops, type SshServerConfig } from '../../shared/ssh-server';
import type {
  ConnectionDraft,
  ConnectionFormState,
  PasswordChangeMessage,
  ServerChoice,
} from '../../shared/protocols/connection-form';

/** What a brand new form starts with. */
export const NEW_CONNECTION: ConnectionInput = {
  name: '',
  driver: 'mysql',
  host: '127.0.0.1',
  port: DEFAULT_PORTS.mysql,
};

/** Drivers the form may offer, with what the page needs to lay out its fields. */
export function driverOptions(): ConnectionFormState['drivers'] {
  // A driver another extension registered has no card in the form: it is made and edited
  // with the editor's own input boxes (V12.7).
  return DRIVER_IDS.filter((id) => id !== 'plugin').map((id) => {
    const defaultPort = DEFAULT_PORTS[id];
    return {
      id,
      file: isFileDriver(id),
      ...(defaultPort === undefined ? {} : { defaultPort }),
    };
  });
}

/**
 * Drops `id`: the editable fields travel on their own, and the schema rejects extras.
 * Every other field is copied as is — a list of fields here lost TLS (V4.5) and the
 * production flags (V4.6) when they were added, and saving the form erased them.
 */
export function toInput(config: ConnectionConfig): ConnectionInput {
  const { id: _id, ...input } = config;
  // The store keeps cleared optional fields as `undefined` keys, which the page's
  // schema would see as present; the types do not show them.
  const entries: [string, unknown][] = Object.entries(input);
  const kept = entries.filter(([, value]) => value !== undefined);
  return Object.fromEntries(kept) as unknown as ConnectionInput;
}

export function toChange(message: PasswordChangeMessage): PasswordChange {
  switch (message.kind) {
    case 'set':
      return { kind: 'set', value: message.value ?? '' };
    case 'clear':
      return { kind: 'clear' };
    case 'keep':
      return { kind: 'keep' };
  }
}

/** Translates the form's password choice into what the store expects. */
export function toPasswordChange(draft: ConnectionDraft): PasswordChange {
  return toChange(draft.password);
}

/** The form's choice for the Sentinel password; a form that says nothing keeps it. */
export function toSentinelChange(draft: ConnectionDraft): PasswordChange {
  return draft.sentinelPassword === undefined ? { kind: 'keep' } : toChange(draft.sentinelPassword);
}

/** The Sentinel password "Test" should use: what the form typed, else what is stored. */
export function testSentinelPassword(
  draft: ConnectionDraft,
  stored: string | undefined,
): string | undefined {
  const change = toSentinelChange(draft);
  switch (change.kind) {
    case 'set':
      return change.value === '' ? undefined : change.value;
    case 'clear':
      return undefined;
    case 'keep':
      return stored;
  }
}

/** The form's choice for the registry's own password or token (V13.41); silence keeps it. */
export function toRegistryChange(draft: ConnectionDraft): PasswordChange {
  return draft.registrySecret === undefined ? { kind: 'keep' } : toChange(draft.registrySecret);
}

/** The registry secret "Test" should use: what the form typed, else what is stored. */
export function testRegistrySecret(
  draft: ConnectionDraft,
  stored: string | undefined,
): string | undefined {
  const change = toRegistryChange(draft);
  switch (change.kind) {
    case 'set':
      return change.value === '' ? undefined : change.value;
    case 'clear':
      return undefined;
    case 'keep':
      return stored;
  }
}

/** The form's choice for the proxy password (V10.2.5); a form that says nothing keeps it. */
export function toProxyChange(draft: ConnectionDraft): PasswordChange {
  return draft.proxyPassword === undefined ? { kind: 'keep' } : toChange(draft.proxyPassword);
}

/** The proxy password "Test" should use: what the form typed, else what is stored. */
export function testProxyPassword(
  draft: ConnectionDraft,
  stored: string | undefined,
): string | undefined {
  const change = toProxyChange(draft);
  switch (change.kind) {
    case 'set':
      return change.value === '' ? undefined : change.value;
    case 'clear':
      return undefined;
    case 'keep':
      return stored;
  }
}

/** The form's choices for SSH secrets, by hop id, as the store expects them. */
export function toSshChanges(draft: Pick<ConnectionDraft, 'ssh'>): SshSecretChanges {
  const changes: Record<string, { password: PasswordChange; passphrase: PasswordChange }> = {};
  for (const change of draft.ssh ?? []) {
    changes[change.hopId] = {
      password: toChange(change.password),
      passphrase: toChange(change.passphrase),
    };
  }
  return changes;
}

/**
 * The SSH secrets "Test" should use: what the form typed, else what is stored —
 * so testing while editing works without retyping a saved password.
 */
export function testSshSecrets(
  draft: ConnectionDraft,
  stored: Readonly<Record<string, SshHopSecrets>>,
): Record<string, SshHopSecrets> {
  return secretsForTest(toSshChanges(draft), sshHopsOf(draft.input), stored);
}

/** The same for any list of hops: what was typed for each, else what is stored. */
export function secretsForTest(
  changes: SshSecretChanges,
  hops: readonly { readonly id: string }[],
  stored: Readonly<Record<string, SshHopSecrets>>,
): Record<string, SshHopSecrets> {
  const result: Record<string, SshHopSecrets> = {};
  for (const hop of hops) {
    const pick = (kind: keyof SshHopSecrets): string | undefined => {
      const change = changes[hop.id]?.[kind] ?? { kind: 'keep' };
      if (change.kind === 'set') {
        return change.value === '' ? undefined : change.value;
      }
      return change.kind === 'clear' ? undefined : stored[hop.id]?.[kind];
    };
    const password = pick('password');
    const passphrase = pick('passphrase');
    result[hop.id] = {
      ...(password === undefined ? {} : { password }),
      ...(passphrase === undefined ? {} : { passphrase }),
    };
  }
  return result;
}

/** Which hops have stored secrets; the values themselves never reach the page. */
export function storedSshFlags(
  stored: Readonly<Record<string, SshHopSecrets>>,
): ConnectionFormState['storedSsh'] {
  return Object.entries(stored).map(([hopId, secrets]) => ({
    hopId,
    password: secrets.password !== undefined,
    passphrase: secrets.passphrase !== undefined,
  }));
}

/** What the host reads from the saved servers; `ServerStore` has all of it. */
export interface ServerSecretSource {
  list(): SshServerConfig[];
  get(id: string): SshServerConfig | undefined;
  getSshSecrets(id: string): Promise<Record<string, SshHopSecrets>>;
  getProxyPassword(id: string): Promise<string | undefined>;
}

/** The saved servers a tunnel can be filled from, with flags about their secrets (V15.1). */
export async function serverChoices(source: ServerSecretSource): Promise<ServerChoice[]> {
  const choices: ServerChoice[] = [];
  for (const server of source.list()) {
    choices.push({
      server,
      storedSsh: storedSshFlags(await source.getSshSecrets(server.id)),
      proxyPassword: (await source.getProxyPassword(server.id)) !== undefined,
    });
  }
  return choices;
}

/** The same login: a secret of the server is not given to a host the user has since changed. */
function sameLogin(a: SshHop, b: SshHop): boolean {
  return a.host === b.host && a.user === b.user && effectiveSshPort(a) === effectiveSshPort(b);
}

/**
 * The secret changes of hops filled from a saved server, with each secret the user left alone
 * replaced by the server's own, so the page never sees it. Typing or erasing in the form wins,
 * and so does a login edited after the pick (V15.1).
 */
export async function resolveHopSecrets(
  changes: ConnectionDraft['ssh'],
  hops: readonly SshHop[],
  source: ServerSecretSource,
): Promise<ConnectionDraft['ssh']> {
  if (changes === undefined) {
    return undefined;
  }
  return await Promise.all(
    changes.map(async (change) => {
      const { fromServer } = change;
      const server = fromServer === undefined ? undefined : source.get(fromServer.serverId);
      const from =
        server === undefined
          ? undefined
          : serverHops(server).find((hop) => hop.id === fromServer?.hopId);
      const hop = hops.find((candidate) => candidate.id === change.hopId);
      if (
        server === undefined ||
        from === undefined ||
        hop === undefined ||
        !sameLogin(from, hop)
      ) {
        return change;
      }
      const secrets = (await source.getSshSecrets(server.id))[from.id] ?? {};
      const take = (kind: keyof SshHopSecrets): PasswordChangeMessage => {
        const value = secrets[kind];
        return change[kind].kind === 'keep' && value !== undefined
          ? { kind: 'set', value }
          : change[kind];
      };
      return { ...change, password: take('password'), passphrase: take('passphrase') };
    }),
  );
}

/** The connection draft with the secrets of what was filled from a saved server (V15.1). */
export async function resolveServerSecrets(
  draft: ConnectionDraft,
  source: ServerSecretSource | undefined,
): Promise<ConnectionDraft> {
  if (source === undefined) {
    return draft;
  }
  const ssh = await resolveHopSecrets(draft.ssh, sshHopsOf(draft.input), source);
  let result: ConnectionDraft = { ...draft, ...(draft.ssh === undefined ? {} : { ssh }) };
  const proxy = draft.input.proxy;
  const server =
    draft.proxyFromServer === undefined ? undefined : source.get(draft.proxyFromServer);
  if (
    proxy !== undefined &&
    server?.proxy !== undefined &&
    (draft.proxyPassword === undefined || draft.proxyPassword.kind === 'keep') &&
    proxy.kind === server.proxy.kind &&
    proxy.host === server.proxy.host &&
    effectiveProxyPort(proxy) === effectiveProxyPort(server.proxy) &&
    proxy.user === server.proxy.user
  ) {
    const value = await source.getProxyPassword(server.id);
    if (value !== undefined) {
      result = { ...result, proxyPassword: { kind: 'set', value } };
    }
  }
  return result;
}
