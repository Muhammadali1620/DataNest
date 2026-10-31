// Kept apart from commands.ts (no vscode import), so tests can compare it with package.json.

/** Every command the extension contributes: `<extId>.<area>.<action>` (ARCHITECTURE.md §10). */
export const COMMAND_IDS = {
  showLogs: 'datanest.logs.show',
  /** Opens the bug form on GitHub with the versions filled in (V9.6). */
  reportIssue: 'datanest.help.reportIssue',
  /** Opens the form for a new connection. */
  addConnection: 'datanest.connections.add',
  /** Opens the form filled from a connection URL. */
  addConnectionFromUrl: 'datanest.connections.addFromUrl',
  /** Adds connections found in the workspace's .env files. */
  importEnvConnections: 'datanest.connections.importEnv',
  /** Writes chosen connections, without secrets, to a file (V4.11). */
  exportConnections: 'datanest.connections.export',
  /** Adds connections from such a file. */
  importConnections: 'datanest.connections.import',
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
  /** Picks which databases, or which schemas, a connection shows (V4.10). */
  filterDatabases: 'datanest.connections.filterDatabases',
  filterSchemas: 'datanest.connections.filterSchemas',
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
  /** Shows the plan of the statement under the cursor (V8.2). */
  explainQuery: 'datanest.query.explain',
  /** Runs the statement under the cursor for its real plan (V8.2). */
  explainAnalyze: 'datanest.query.explainAnalyze',
  /** Saves the open transaction of the active editor (V4.8). */
  commitTransaction: 'datanest.transaction.commit',
  /** Undoes the open transaction of the active editor. */
  rollbackTransaction: 'datanest.transaction.rollback',
  /** Switches the active editor between auto-commit and manual commit. */
  toggleTransactionMode: 'datanest.transaction.toggleMode',
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
  /** Runs a SQL file of any size, statement by statement as it is read (V5.1). */
  runSqlFile: 'datanest.script.run',
  /** Dumps tables, a database or a schema to a SQL script (V5.2). */
  dumpSql: 'datanest.dump.create',
  /** Writes every row of a table or view to a file, streamed from the server (V5.4). */
  exportData: 'datanest.table.exportData',
  /** Copies tables to another connection, of any kind of database (V5.6). */
  transferTables: 'datanest.table.transfer',
  duplicateTable: 'datanest.table.duplicate',
  openSqliteFile: 'datanest.connections.openSqliteFile',
  filterTables: 'datanest.tree.filterTables',
  /** Fills a table with generated rows (V5.5). */
  generateData: 'datanest.table.generateData',
  /** Compares the rows of two tables and writes the script that syncs them (V8.4). */
  compareData: 'datanest.table.compareData',
  /** Lists the users of a SQL server and grants and revokes their privileges (V8.6). */
  showUsers: 'datanest.server.users',
  /** Shows the sessions, settings and status of a SQL server (V8.5). */
  showMonitor: 'datanest.server.monitor',
  /** Compares two schemas and writes the script that makes one like the other (V8.3). */
  compareSchemas: 'datanest.schema.compare',
  /** Draws the tables of a scope and the keys between them (V8.1). */
  showErDiagram: 'datanest.diagram.show',
  /** Fills a table from a CSV or JSON file (V5.3). */
  importData: 'datanest.table.importData',
  /** Opens a chart of the shown result (V8.7). */
  chartResult: 'datanest.results.chart',
  /** Writes the shown result to a CSV or JSON file. */
  exportResult: 'datanest.results.export',
  /** Browses the history of executed statements. */
  showHistory: 'datanest.history.show',
  /** Finds a table, view or routine in every connected connection. */
  searchObjects: 'datanest.objects.search',
  /** Brings the next portion of a Redis database's keys into the tree (V7.2). */
  redisLoadMoreKeys: 'datanest.redis.loadMoreKeys',
  /** Shows only the keys of a Redis database that match a glob. */
  redisFilterKeys: 'datanest.redis.filterKeys',
  /** Finds a Redis key with SCAN and shows it in the tree. */
  redisFindKey: 'datanest.redis.findKey',
  /** Opens the page of a Redis key: its value, TTL, size (V7.3). */
  redisOpenKey: 'datanest.redis.openKey',
  redisNewKey: 'datanest.redis.newKey',
  redisRenameKey: 'datanest.redis.renameKey',
  /** Deletes the clicked key, or every selected one. */
  redisDeleteKeys: 'datanest.redis.deleteKeys',
  /** A console that runs Redis commands, with suggestions (V7.4). */
  redisOpenConsole: 'datanest.redis.openConsole',
  /** What a Redis server reports about itself (INFO). */
  redisServerInfo: 'datanest.redis.serverInfo',
  /** A MongoDB database comes to be with its first collection (V7.5). */
  mongoNewDatabase: 'datanest.mongo.newDatabase',
  mongoDropDatabase: 'datanest.mongo.dropDatabase',
  mongoNewCollection: 'datanest.mongo.newCollection',
  mongoRenameCollection: 'datanest.mongo.renameCollection',
  /** Drops a collection or a view. */
  mongoDropCollection: 'datanest.mongo.dropCollection',
  mongoNewIndex: 'datanest.mongo.newIndex',
  mongoDropIndex: 'datanest.mongo.dropIndex',
  /** The documents of a collection or view as a table and as text (V7.6). */
  mongoOpenCollection: 'datanest.mongo.openCollection',
  /** A query editor bound to a MongoDB connection and database (V7.7). */
  mongoNewQuery: 'datanest.mongo.newQuery',
  /** Runs the selection or the statement at the cursor of a MongoDB query (Ctrl+Enter). */
  mongoRunQuery: 'datanest.mongo.runQuery',
  /** Runs one statement by its offsets; used by the CodeLens above it. */
  mongoRunStatement: 'datanest.mongo.runStatement',
  /** Points a MongoDB query at another connection or database. */
  mongoPickDatabase: 'datanest.mongo.pickDatabase',
  /** Elasticsearch indices and requests (V7.8). */
  elasticNewIndex: 'datanest.elastic.newIndex',
  elasticDeleteIndex: 'datanest.elastic.deleteIndex',
  /** A query editor bound to an Elasticsearch connection. */
  elasticNewQuery: 'datanest.elastic.newQuery',
  /** Sends the request at the cursor of an Elasticsearch query (Ctrl+Enter). */
  elasticRunQuery: 'datanest.elastic.runQuery',
  /** Sends one request by its offset; used by the CodeLens above it. */
  elasticRunRequest: 'datanest.elastic.runRequest',
  /** Points an Elasticsearch query at another connection. */
  elasticPickConnection: 'datanest.elastic.pickConnection',
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
  /** Share the connection list through the editor's Settings Sync (V10.2.5). */
  syncConnections: 'connections.sync',
  /** Rows, size and comment of tables in the tree (V10.2.3). */
  treeTableStats: 'tree.tableStats',
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
  /** How new SQL editors commit: each statement at once, or on the user's Commit. */
  transactionMode: 'transactionMode',
  /** What `:name` and `${name}` in a statement do: ask and remember, ask, or nothing. */
  queryVariables: 'queryVariables',
  /** SQL editors (V10.2.2): the Run lenses, the current statement, statement folding. */
  editorCodeLens: 'editor.codeLens',
  editorHighlightStatement: 'editor.highlightStatement',
  editorFoldStatements: 'editor.foldStatements',
  // How Format Document writes SQL (sql-formatter options).
  formatKeywordCase: 'format.keywordCase',
  formatDataTypeCase: 'format.dataTypeCase',
  formatFunctionCase: 'format.functionCase',
  formatIndentStyle: 'format.indentStyle',
  formatLogicalOperatorNewline: 'format.logicalOperatorNewline',
  formatExpressionWidth: 'format.expressionWidth',
  formatDenseOperators: 'format.denseOperators',
  /** What splits Redis key names into folders (V7.2). */
  redisKeySeparator: 'redis.keySeparator',
  /** How many Redis keys the tree loads at a time. */
  redisKeysPerLoad: 'redis.keysPerLoad',
} as const;
