// Kept apart from commands.ts (no vscode import), so tests can compare it with package.json.

/** Every command the extension contributes: `<extId>.<area>.<action>` (ARCHITECTURE.md §10). */
export const COMMAND_IDS = {
  showLogs: 'datanest.logs.show',
  /** Opens the form for a new connection. */
  addConnection: 'datanest.connections.add',
  /** Opens the form for an existing connection. */
  editConnection: 'datanest.connections.edit',
  duplicateConnection: 'datanest.connections.duplicate',
  removeConnection: 'datanest.connections.remove',
  /** Diagnostic page for webview + RPC; in the palette only in development mode. */
  openPing: 'datanest.dev.openPing',
} as const;

/** Context keys set with `setContext`, used in `when` clauses of package.json. */
export const CONTEXT_KEYS = {
  isDevelopment: 'datanest.isDevelopment',
} as const;

export type CommandId = (typeof COMMAND_IDS)[keyof typeof COMMAND_IDS];

/** Settings section and keys, read via `workspace.getConfiguration(CONFIG_SECTION)`. */
export const CONFIG_SECTION = 'datanest';

export const CONFIG_KEYS = {
  logLevel: 'logLevel',
} as const;
