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
  type SshHopSecrets,
  sshHopsOf,
} from '../../shared/connection';
import type {
  ConnectionDraft,
  ConnectionFormState,
  PasswordChangeMessage,
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
  return DRIVER_IDS.map((id) => {
    const defaultPort = DEFAULT_PORTS[id];
    return {
      id,
      file: isFileDriver(id),
      ...(defaultPort === undefined ? {} : { defaultPort }),
    };
  });
}

/** Drops `id`: the editable fields travel on their own, and the schema rejects extras. */
export function toInput(config: ConnectionConfig): ConnectionInput {
  return {
    name: config.name,
    driver: config.driver,
    ...(config.host === undefined ? {} : { host: config.host }),
    ...(config.port === undefined ? {} : { port: config.port }),
    ...(config.user === undefined ? {} : { user: config.user }),
    ...(config.database === undefined ? {} : { database: config.database }),
    ...(config.file === undefined ? {} : { file: config.file }),
    ...(config.ssh === undefined ? {} : { ssh: config.ssh }),
    ...(config.ssl === undefined ? {} : { ssl: config.ssl }),
    ...(config.folder === undefined ? {} : { folder: config.folder }),
    ...(config.color === undefined ? {} : { color: config.color }),
  };
}

function toChange(message: PasswordChangeMessage): PasswordChange {
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

/** The form's choices for SSH secrets, by hop id, as the store expects them. */
export function toSshChanges(draft: ConnectionDraft): SshSecretChanges {
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
  const changes = toSshChanges(draft);
  const result: Record<string, SshHopSecrets> = {};
  for (const hop of sshHopsOf(draft.input)) {
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
