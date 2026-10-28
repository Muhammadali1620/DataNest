// What the status bar shows for the SQL document in front of the user.
// Free of `vscode` so the wording and the states are covered by unit tests.

import type { ConnectionState } from '../../services/connection-manager';
import type { ConnectionConfig } from '../../shared/connection';
import type { DocumentBinding } from './document-bindings';

export interface StatusTexts {
  /** Shown when the document has no connection yet. */
  readonly pick: string;
  /** Tooltip explaining what a click does. */
  readonly tooltip: string;
  readonly connecting: string;
  readonly failed: string;
  readonly notConnected: string;
  /** Prefixes of a production and of a read-only connection. */
  readonly production: string;
  readonly readOnly: string;
}

export interface StatusView {
  readonly text: string;
  readonly tooltip: string;
  /** True while the connection is in trouble, so the item can stand out. */
  readonly warning: boolean;
  /** True for a production connection: the item is shown in the error color. */
  readonly production?: boolean;
}

/**
 * The label is the connection name, plus the database when the document is pinned
 * to one. A missing connection is not an error: the user has simply not chosen yet.
 */
export function statusView(
  binding: DocumentBinding | undefined,
  config: ConnectionConfig | undefined,
  state: ConnectionState,
  texts: StatusTexts,
): StatusView {
  if (binding === undefined) {
    return { text: texts.pick, tooltip: texts.tooltip, warning: false };
  }
  if (config === undefined) {
    // The connection was deleted while its editor stayed open.
    return { text: texts.pick, tooltip: texts.tooltip, warning: true };
  }
  const target =
    binding.database === undefined ? config.name : `${config.name} · ${binding.database}`;
  const status = statusSuffix(state, texts);
  const marks = [
    ...(config.production === true ? [texts.production] : []),
    ...(config.readOnly === true ? [texts.readOnly] : []),
  ].join(' ');
  const label = status === undefined ? target : `${target} (${status})`;
  return {
    text: marks === '' ? label : `${marks} ${label}`,
    tooltip: `${target}\n${texts.tooltip}`,
    warning: state.status === 'error',
    ...(config.production === true ? { production: true } : {}),
  };
}

function statusSuffix(state: ConnectionState, texts: StatusTexts): string | undefined {
  switch (state.status) {
    case 'connecting':
      return texts.connecting;
    case 'error':
      return texts.failed;
    case 'disconnected':
      return texts.notConnected;
    case 'connected':
      return undefined;
  }
}
