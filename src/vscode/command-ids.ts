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
  connect: 'datanest.connections.connect',
  disconnect: 'datanest.connections.disconnect',
  refreshTree: 'datanest.tree.refresh',
  copyName: 'datanest.tree.copyName',
  /** Opens an empty SQL document bound to a connection. */
  newQuery: 'datanest.query.new',
  /** Picks the connection and database of the active SQL document. */
  selectConnection: 'datanest.query.selectConnection',
  /** Runs the selection, or the statement the cursor is in. */
  runQuery: 'datanest.query.run',
  /** Runs every statement of the document. */
  runAll: 'datanest.query.runAll',
  /** Runs one statement by offsets; used by the CodeLens above it. */
  runRange: 'datanest.query.runRange',
  /** Stops the statement running in this editor. */
  cancelQuery: 'datanest.query.cancel',
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
  /** Show the server's own databases and schemas in the tree. */
  showSystemObjects: 'showSystemObjects',
  /** Largest number of rows one statement brings back. */
  rowLimit: 'rowLimit',
} as const;
