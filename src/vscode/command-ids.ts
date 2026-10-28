// Kept apart from commands.ts (no vscode import), so tests can compare it with package.json.

/** Every command the extension contributes: `<extId>.<area>.<action>` (ARCHITECTURE.md §10). */
export const COMMAND_IDS = {
  showLogs: 'datanest.logs.show',
  /** Opens the form for a new connection. */
  addConnection: 'datanest.connections.add',
  /** Opens the form filled from a connection URL. */
  addConnectionFromUrl: 'datanest.connections.addFromUrl',
  /** Adds connections found in the workspace's .env files. */
  importEnvConnections: 'datanest.connections.importEnv',
  /** Folders of connections in the tree. */
  createFolder: 'datanest.folders.create',
  renameFolder: 'datanest.folders.rename',
  removeFolder: 'datanest.folders.remove',
  /** Puts the clicked (and selected) connections into a folder. */
  moveToFolder: 'datanest.connections.moveToFolder',
  /** Moves one of the user's connections into the project's `.vscode/datanest.json`. */
  moveToProject: 'datanest.connections.moveToProject',
  /** Takes a connection out of the project file and keeps it as the user's own. */
  moveToUser: 'datanest.connections.moveToUser',
  /** Opens (creating it when missing) the project's `.vscode/datanest.json`. */
  openProjectFile: 'datanest.project.openFile',
  /** Gives a connection a color label. */
  setConnectionColor: 'datanest.connections.setColor',
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
  /** Opens (or brings back) the result panel of the active query. */
  showResults: 'datanest.results.show',
  /** Opens a table or view from the tree as a paged result. */
  openTable: 'datanest.table.open',
  /** Opens the DDL of a tree object in a new SQL editor. */
  showDefinition: 'datanest.object.showDefinition',
  // Structure changes from the tree; each shows its SQL before it runs.
  createDatabase: 'datanest.database.create',
  dropDatabase: 'datanest.database.drop',
  createSchema: 'datanest.schema.create',
  dropSchema: 'datanest.schema.drop',
  createTable: 'datanest.table.create',
  /** Opens an existing table in the table designer. */
  designTable: 'datanest.table.design',
  // Statement templates for a table, opened in a new editor.
  generateSelect: 'datanest.table.generateSelect',
  generateInsert: 'datanest.table.generateInsert',
  generateUpdate: 'datanest.table.generateUpdate',
  generateDelete: 'datanest.table.generateDelete',
  dropTable: 'datanest.table.drop',
  renameTable: 'datanest.table.rename',
  truncateTable: 'datanest.table.truncate',
  dropObject: 'datanest.object.drop',
  /** Opens the definition of a view, routine, trigger or event for editing. */
  editObject: 'datanest.object.edit',
  /** Puts the edited definition of the active editor in place of the object. */
  applyObject: 'datanest.object.apply',
  /** Writes the shown result to a CSV or JSON file. */
  exportResult: 'datanest.results.export',
  /** Browses the history of executed statements. */
  showHistory: 'datanest.history.show',
  /** Finds a table, view or routine in every connected connection. */
  searchObjects: 'datanest.objects.search',
  /** Diagnostic page for webview + RPC; in the palette only in development mode. */
  openPing: 'datanest.dev.openPing',
} as const;

/** Context keys set with `setContext`, used in `when` clauses of package.json. */
export const CONTEXT_KEYS = {
  isDevelopment: 'datanest.isDevelopment',
  /** True while a query of the active editor is running. */
  queryRunning: 'datanest.queryRunning',
  /** True while the active editor edits the definition of a database object. */
  objectEditor: 'datanest.objectEditor',
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
  /** Rows one page of a table view holds. */
  pageSize: 'pageSize',
  /** Seconds a statement may run before it is cancelled; 0 means no limit. */
  queryTimeout: 'queryTimeout',
  /** How many executed statements the history keeps; 0 turns it off. */
  historyLimit: 'historyLimit',
  /** What happens before a statement that can destroy data runs: confirm, block or off. */
  safeMode: 'safeMode',
  // How Format Document writes SQL (sql-formatter options).
  formatKeywordCase: 'format.keywordCase',
  formatDataTypeCase: 'format.dataTypeCase',
  formatFunctionCase: 'format.functionCase',
  formatIndentStyle: 'format.indentStyle',
  formatLogicalOperatorNewline: 'format.logicalOperatorNewline',
  formatExpressionWidth: 'format.expressionWidth',
  formatDenseOperators: 'format.denseOperators',
} as const;
