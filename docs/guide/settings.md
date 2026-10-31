# Settings

Open **Preferences: Open Settings** and search for `datanest`. Every setting applies at
once, without a restart.

## Queries and results

| Setting | Default | Values | What it does |
|---|---|---|---|
| `datanest.rowLimit` | `1000` | 1 – 1 000 000 | How many rows one statement may bring back. Larger results are cut off, and the result says it was truncated. |
| `datanest.pageSize` | `200` | 1 – 100 000 | Rows on one page when a table is opened from the tree. |
| `datanest.queryTimeout` | `0` | 0 – 86 400 s | Seconds a statement may run before DataNest cancels it; `0` means no limit. A connection's own query timeout wins over this. |
| `datanest.transactionMode` | `auto` | `auto`, `manual` | How a new SQL editor commits: every statement at once, or in a transaction that waits for **Commit** or **Roll Back**. |
| `datanest.queryVariables` | `remember` | `remember`, `ask`, `off` | What `:name` and `${name}` in a statement do: ask for the value and offer the one given last time, ask every time and keep nothing, or leave them in the text. See [Variables](sql.md#variables). |
| `datanest.safeMode` | `confirm` | `confirm`, `block`, `off` | What happens before a `DELETE` or `UPDATE` without `WHERE`, a `DROP` or a `TRUNCATE` (and their Redis, MongoDB and Elasticsearch kin): ask, refuse or just run. |
| `datanest.historyLimit` | `500` | 0 – 10 000 | Statements kept in the query history; `0` turns it off. Passwords in statements are masked before saving. |

## SQL editors

| Setting | Default | Values | What it does |
|---|---|---|---|
| `datanest.editor.codeLens` | `true` | | Show **▶ Run** above each statement. |
| `datanest.editor.highlightStatement` | `true` | | Highlight the statement under the cursor — the one `Ctrl+Enter` runs — when a file holds several. Its colour is `datanest.statementHighlightBackground` in `workbench.colorCustomizations`. |
| `datanest.editor.foldStatements` | `true` | | Fold by statements, block comments, `-- #region` markers and indentation. Off: the editor's own folding by indentation. |

## The tree

| Setting | Default | Values | What it does |
|---|---|---|---|
| `datanest.showSystemObjects` | `false` | | Show the databases and schemas the server keeps for itself, such as `information_schema` and `pg_catalog`. |
| `datanest.connections.sync` | `false` | | Share the connection list between your computers through the editor's Settings Sync. Passwords never travel. |
| `datanest.tree.expandOnlyByArrow` | `true` | | A table in the tree opens and closes only by its arrow; a double click on its name opens its data and leaves the row as it was. The editor toggles a row on a double click by itself and cannot be told otherwise for one view, so DataNest puts the row back at once (one blink at most). Turn it off to keep the editor's own behaviour. |
| `datanest.tree.showSizes` | `true` | | Show the size of a database or schema after its name (`public 2.4M`). It is read lazily with one small query and never blocks the tree. The server version after a connection (`15.19 · user@host:5432`) is always shown, and kept for the next start, so it is there before you connect. |
| `datanest.tree.tableStats` | `true` | | Show each table's estimated rows in the tree, and its size and comment in the tooltip, from the server's statistics. |
| `datanest.redis.keySeparator` | `:` | | What splits Redis key names into folders, e.g. `user:1:name` → `user` → `1`. Empty: no folders. |
| `datanest.redis.keysPerLoad` | `5000` | 100 – 100 000 | How many Redis keys are loaded at a time with `SCAN`; **Load More Keys** brings the next portion. |

## Formatting SQL

Used by **Format Document** in an SQL editor bound to a connection, in that connection's
dialect.

| Setting | Default | Values | What it does |
|---|---|---|---|
| `datanest.format.keywordCase` | `upper` | `upper`, `lower`, `preserve` | Letter case of keywords (`SELECT`, `FROM`, …). |
| `datanest.format.dataTypeCase` | `preserve` | `upper`, `lower`, `preserve` | Letter case of data types (`varchar`, `INTEGER`, …). |
| `datanest.format.functionCase` | `preserve` | `upper`, `lower`, `preserve` | Letter case of function names (`count`, `NOW`, …). |
| `datanest.format.indentStyle` | `standard` | `standard`, `tabularLeft`, `tabularRight` | How clauses are indented. |
| `datanest.format.logicalOperatorNewline` | `before` | `before`, `after` | Where `AND` and `OR` go when a condition is split over lines. |
| `datanest.format.expressionWidth` | `50` | 10 – 1000 | A parenthesized expression shorter than this stays on one line. |
| `datanest.format.denseOperators` | `false` | | Write `a+b` instead of `a + b`. |

## Diagnostics

| Setting | Default | Values | What it does |
|---|---|---|---|
| `datanest.logLevel` | `info` | `error`, `warn`, `info`, `debug` | How much DataNest writes to its output channel (**Show Logs**). Passwords and tokens are never logged. |

Per-connection settings — timeouts, keep-alive, time zone, character set, init SQL, which
databases and schemas to show — are in the connection form; see
[Connections](connections.md#per-connection-options).
