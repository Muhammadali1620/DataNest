# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Connect through an SSH tunnel: log in with a password, a private key (with its
  passphrase) or an SSH agent. Secrets stay in the editor's secret storage. The first
  connection to a server shows its key fingerprint to trust, and a changed key is
  refused.

## [0.3.0] - 2026-10-28

Database structure: read and change the schema without writing DDL by hand, and a
smarter SQL editor.

### Added

**Structure in the tree**

- Functions, procedures, sequences (PostgreSQL) and events (MySQL, MariaDB) next to
  tables and views; every table has Indexes, Foreign Keys and Triggers folders, and
  PostgreSQL overloads show their arguments.
- “Show DDL” on any object opens its definition in a new SQL editor bound to the same
  connection, ready to run: MySQL and MariaDB print it themselves, PostgreSQL gets a
  full `CREATE TABLE` with constraints, indexes, comments and triggers, SQLite shows
  the original text with the table's indexes and triggers.
- Create and drop databases and schemas; create, rename, empty and drop tables and
  views; drop functions, procedures, triggers, sequences and events. Every action
  shows its SQL first, with “Run” and “Open in Editor”; dropping a database or a
  schema also asks for its name.
- “Find Database Object…” searches the tables, views, routines, sequences and events
  of every connected connection in one list; choosing one opens its data or its DDL.

**Table designer**

- Columns with type, length, `NOT NULL`, default, primary key, auto numbering and
  comment, in any order; indexes and foreign keys (with `ON DELETE` / `ON UPDATE`)
  in tabs of their own; the SQL it will run is shown as you type.
- “Edit Table…” opens an existing table and turns the difference into
  `ALTER TABLE`: renames stay renames, MySQL rewrites only the columns that changed
  or moved, PostgreSQL applies everything in one transaction, SQLite changes what it
  can in place and otherwise rebuilds the table, keeping rows, indexes, triggers and
  views. Indexes the designer cannot express are kept as they are.

**Views, routines and triggers**

- “Edit Definition…” opens a view, function, procedure, trigger or event as SQL;
  “Apply” replaces it. MySQL first tries the new text out under a scratch name, so a
  typo or a missing privilege never drops the original; PostgreSQL and SQLite
  replace it in one transaction.
- “Generate SELECT / INSERT / UPDATE / DELETE” on a table writes the statement with
  its real columns and key into a new editor, with tab stops for the values.

**SQL editor**

- Format Document and Format Selection, in the dialect of the bound connection,
  with `datanest.format.*` settings for keyword, type and function case, indentation
  style, `AND`/`OR` placement, expression width and dense operators. `DELIMITER`
  commands and statements the formatter cannot read stay as they are.
- Smarter completion: columns of every joined table labelled with their alias,
  aliases themselves, CTEs and subqueries in `FROM` with the columns of their select
  list (`*` included), dialect functions inserted as calls with argument
  placeholders, and statement snippets (`sel`, `join`, `ins`, `upd`, `cte`, `upsert`…).
- Hover over a table or a column shows its type, `NOT NULL`, key, default, where a
  foreign key points and the comment; over a CTE, its columns. Go to Definition (F12)
  on a table, view, column or routine call opens its DDL, read-only.
- A failed statement shows its error as a squiggle in the editor and in Problems, on
  the word the server complained about.

### Fixed

- A SQLite `CREATE TRIGGER … BEGIN … END` with several statements in its body is no
  longer split into pieces when it runs.
- SQLite results with two columns of the same name (`SELECT a.id, b.id …`) showed
  the last value in both; each column now keeps its own.
- MySQL and SQLite error positions are read from their messages, so “jump to the
  error” in the results panel is exact there too.
- After a `;` completion treats the cursor as the start of a new statement, and
  `FROM schema.` offers the tables of that schema.
- MariaDB sequences no longer appear among the tables; MariaDB's “Unknown data type”
  is reported as a syntax error.

## [0.2.0] - 2026-10-28

> 0.2.0 was prepared but not published on its own; its changes ship with 0.3.0.

Working with data: edit rows in place, filter and page tables on the server, copy
and export in many formats, and keep a history of what ran.

### Added

**Editing**

- A result from one table with a primary key (or a unique key over `NOT NULL`
  columns) can be edited in place; anything else is read-only, and the panel says why.
- Type-aware cell editors: text, numbers without precision loss, booleans, dates,
  times, timestamps, JSON and enums, plus “Set NULL” and “Set DEFAULT”.
- Add, duplicate and delete rows, several at once (`Insert`, `Ctrl+Delete`).
- A queue of pending changes with highlighting, undo, “Preview SQL”, and saving in
  one transaction (`Ctrl+S`). Every row must change exactly one record, otherwise
  everything is rolled back and the queue stays.
- A record card (`Shift+F4`): one row as a vertical form, with the same editors.
- A value panel (`F4`): long text, formatted JSON that keeps every digit, a hex
  dump of binary data and images stored in BLOBs.

**Tables**

- A server-side filter builder (equals, contains, starts with, NULL, …) plus a
  hand-written `WHERE`; clicking a header sorts on the server.
- Paging: page size, go to page, “Load all” with a warning, and a fast estimated
  row count for big tables, with an exact `COUNT(*)` on demand.
- Following a foreign key from a cell (`Ctrl+click` or `F12`) opens the referenced
  table filtered to that row.
- Hide and pin columns, and fit column widths to their content.

**Copy and export**

- “Copy as” TSV, CSV, JSON, Markdown, SQL `INSERT`, SQL `UPDATE` and an `IN (…)` list.
- Export to SQL `INSERT`, Markdown and Excel (`.xlsx`), next to CSV and JSON.
  Long numbers and leading zeros stay text in Excel, so nothing is rounded.

**Queries**

- Query history: search, rerun, copy, delete, filter by connection
  (`datanest.historyLimit`). Passwords in statements are masked before saving.
- Safe mode asks before `DELETE`/`UPDATE` without `WHERE`, `DROP` and `TRUNCATE`
  (`datanest.safeMode`: `confirm`, `block` or `off`).

## [0.1.2] - 2026-10-24

### Fixed

- Column resizing no longer depends on `setPointerCapture`, which not every host
  provides; the drag works without it.

> 0.1.1 was tagged but never published: its release run failed before publishing,
> and a tag that is already pushed is not moved.

## [0.1.0] - 2026-10-24

The first working release: connect, browse, write SQL, read the results.

### Added

**Connections**

- MySQL and MariaDB (`mysql2`), PostgreSQL (`pg`) and SQLite (`node:sqlite` in a
  worker thread). Each driver is a separate bundle, loaded on first use.
- Connection form with “Test connection”, editing, duplicating and deleting.
  Passwords are kept in SecretStorage and never travel back to the page.
- One session per editor, reconnecting by itself after a dropped link — without
  ever repeating the statement that failed.

**Browsing**

- Connections view: connection → databases → schemas → tables and views → columns,
  with type, primary key, `NOT NULL` and defaults.
- Inline buttons and context menus: connect, disconnect, refresh, new query,
  open table, copy name, edit, duplicate, delete.
- Metadata cache with invalidation on Refresh and after a statement that changes
  structure; concurrent identical reads share one request.
- System databases and schemas hidden by default (`datanest.showSystemObjects`).

**SQL editor**

- “New Query” opens a SQL document bound to a connection and database, shown and
  switchable in the status bar.
- `Ctrl+Enter` runs the statement under the cursor or the selection,
  `Ctrl+Shift+Enter` the whole file, plus a “▶ Run” CodeLens per statement.
- Statement splitting that understands strings, comments, `$$ … $$` in PostgreSQL,
  backticks and `DELIMITER` in MySQL.
- Completion for dialect keywords, tables and columns, including after `alias.`.
- Elapsed-time indicator and cancelling a running query.

**Results**

- Virtualized grid with a sticky header, resizable columns, row numbers and an
  explicit `NULL`; rows stay in the extension host and load in windows.
- Sorting by clicking a header and a search over the whole result.
- Cell and range selection with the mouse and the keyboard, copy as TSV.
- Export to CSV or JSON — the whole result, not just what is on screen.
- One tab per statement, with affected rows, duration, and errors that point at
  the character the server complained about.
- “Open Table” from the tree, paged, with the total row count.

**Settings**

- `datanest.rowLimit`, `datanest.pageSize`, `datanest.queryTimeout`,
  `datanest.showSystemObjects`, `datanest.logLevel`.

### Notes

- No telemetry, no accounts, no feature behind a paywall.
- Values keep their precision: `BIGINT`, `DECIMAL`, timestamps and binary data are
  never rounded or reinterpreted on the way to the screen, the clipboard or a file.
