// Pure parts of the connection form panel: what the page is told about drivers and
// how its password choice maps onto the store. Kept free of `vscode` so unit tests
// can cover it (ARCHITECTURE.md §11).

import type { PasswordChange } from '../../services/connection-store';
import {
  type ConnectionConfig,
  type ConnectionInput,
  DEFAULT_PORTS,
  DRIVER_IDS,
  isFileDriver,
} from '../../shared/connection';
import type { ConnectionDraft, ConnectionFormState } from '../../shared/protocols/connection-form';

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
  };
}

/** Translates the form's password choice into what the store expects. */
export function toPasswordChange(draft: ConnectionDraft): PasswordChange {
  switch (draft.password.kind) {
    case 'set':
      return { kind: 'set', value: draft.password.value ?? '' };
    case 'clear':
      return { kind: 'clear' };
    case 'keep':
      return { kind: 'keep' };
  }
}
