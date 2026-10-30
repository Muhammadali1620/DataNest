# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- ER diagram of a database, schema or chosen tables: a box per table with its columns,
  primary and foreign key marks, and the keys between tables in crow's foot notation.
  Tables are laid out automatically — a referenced table left of the tables that point at
  it — and can be dragged; pan, zoom, find a table, highlight its keys, open its rows with
  a double click. Show all columns, key columns only or just names. Save the diagram as
  SVG or PNG in the colours of the current theme.

## [0.7.0] - 2026-10-29

NoSQL: Redis, MongoDB and Elasticsearch, each with the tree, pages and an editor of its
own, and the same connections, SSH, TLS, production and read-only marks as SQL.

### Added

- Redis: connect to one server, through Sentinels or to a cluster, with a password or an
  ACL user, TLS and SSH (to one server); `redis://`, `rediss://` and `valkey://` URLs and
  Laravel's `REDIS_*` in `.env` fill the form. The tree lists the numbered databases with
  their key counts, and the keys of each grouped into folders by `:` (or any separator),
  loaded with `SCAN` a portion at a time so even millions of keys never block the server.
  Find a key as you type, filter a database by a pattern.
- A page per Redis key: type, size, memory, TTL that counts down; strings as text, JSON
  or hex; hashes, lists, sets, sorted sets and streams a page at a time, with editing,
  adding and deleting; rename, delete and new keys. Binary keys and values stay exact.
- A Redis console with suggestions for every command the server documents, the syntax
  of the one being typed and key names where a key goes, history, and replies printed as
  redis-cli prints them; and a server information page (INFO, by master in a cluster).
- Production connections ask before every Redis change, read-only ones refuse them, and
  safe mode asks before `FLUSHALL`, `FLUSHDB`, `CONFIG SET`, `KEYS` and the like.
- MongoDB: connect to one server, a replica set or an SRV record (`mongodb+srv://`, Atlas),
  with a password (SCRAM, LDAP) or a client certificate (X.509), TLS and SSH (to one
  server); `mongodb://` URLs and `MONGO_URL` or Laravel's `DB_CONNECTION=mongodb` in `.env`
  fill the form. The tree lists databases with their size, collections, time series and
  views, and the indexes of each collection with their keys and options (unique, TTL,
  partial, text, geo, hashed). Create and drop databases, collections and indexes, rename
  collections. Values keep their exact BSON type and documents their field order.
- A page per MongoDB collection: find documents with a filter, a sort and a projection in
  the shell's syntax, page through them, see them as a table (sort by a click on a column)
  or as text, with the count of what matches. Edit a document as text, add, copy and
  delete documents; a save never overwrites a document someone else changed meanwhile.
- MongoDB queries in the editor: a query document bound to a connection and a database
  runs the statement under the cursor with Ctrl+Enter or the ▶ Run above it — `find` with
  `.sort().limit()`, `aggregate`, counts, `distinct`, inserts, updates, deletes, indexes,
  `db.runCommand`, `use` and `show`. Results open beside the editor, page by page.
  Read-only connections refuse writes, production asks first, and safe mode asks before
  `drop` or a `deleteMany({})` that takes every document.
- Elasticsearch and OpenSearch: connect with a user and password or an API key, TLS and
  SSH, behind a proxy path; `elasticsearch://` URLs and `ELASTICSEARCH_URL` in `.env` fill
  the form. The tree lists indices with their health, documents and size, and the fields
  of each mapping, nested ones inside their field. Create and delete indices. Requests are
  written as in a console — `GET /products/_search` with a JSON body, `_bulk` line by line
  — and sent with Ctrl+Enter; the answer shows the hits as a table and the whole answer
  as text, 64-bit numbers exact. Read-only connections send only what reads, production
  asks first, and safe mode asks before deleting an index or every document.

### Fixed

- Errors of the database drivers kept their kind in the packaged extension: a dropped
  connection now reconnects on the next statement, and a cancelled statement stays quiet.

## [0.6.0] - 2026-10-29

More SQL databases: Microsoft SQL Server, ClickHouse and Oracle with drivers of their own,
and TiDB, CockroachDB, YugabyteDB and Amazon Aurora through the MySQL and PostgreSQL ones.

### Added

- Microsoft SQL Server (2016 and newer, Azure SQL) with everything the other databases
  have: the tree with schemas, routines, triggers and sequences, the SQL editor with
  `GO`, `[names]`, procedure bodies and batch variables, exact values (`DECIMAL`,
  `MONEY`, `datetime2(7)`, `datetimeoffset` with its offset), cancel, transactions, the
  table designer, editing, dumps, imports, exports, test data and copies to and from the
  other databases. Connect by host, `host\INSTANCE` or port, with TLS checks of your choice,
  or paste a `sqlserver://` URL.
- ClickHouse over its HTTP interface: databases, tables, views and materialized views,
  columns with their full types, the sorting key and skipping indexes; exact 64- and
  128-bit integers and decimals; sessions that keep `SET` and `USE`; cancel; read-only
  connections enforced by the server; the table designer (MergeTree, `Nullable`, column
  order), dumps, imports, exports, test data and copies to and from the other databases.
  Results are read-only, since rows have no key.
- Oracle Database (12.2 and newer, through node-oracledb's thin mode: no Instant Client):
  the service is the database and users are its schemas; exact `NUMBER(38)`, `TIMESTAMP(9)`
  and `TIMESTAMP WITH TIME ZONE` with its offset; intervals, LOBs and JSON; PL/SQL in the
  editor and in SQL files, with `/` lines, `q'[…]'` strings and SQL*Plus commands that are
  skipped; what `DBMS_OUTPUT` prints shown as the statement's message; compile errors with
  their line and column; cancel; transactions begun with `SET TRANSACTION` or a savepoint;
  names written without quotes found the way Oracle reads them (`orders` is `ORDERS`); the
  table designer (identity columns, comments), editing, dumps that load under another user,
  imports, exports, test data and copies to and from the other databases.

- Servers that speak MySQL's or PostgreSQL's protocol, checked on real servers: TiDB,
  CockroachDB, YugabyteDB and Amazon Aurora. The connection form offers them as
  “Compatible servers” with their port, account and TLS; `cockroachdb://`, `yugabytedb://`
  and `tidb://` URLs work too. Definitions, dumps, cancel and the designer follow what each
  server's catalogs have.

### Changed

- Dumps of MySQL databases start their snapshot without `READ ONLY`, which TiDB does not
  take next to `CONSISTENT SNAPSHOT`.
- Where a database has no transactions (ClickHouse), “all or nothing” imports stop at the
  first bad row and say that the rows before it stay.

### Fixed

- A statement that returns several sets of rows (a MySQL `CALL`, a SQL Server batch)
  shows the first set instead of mixing the rows of all of them under its columns.
- Copying tables between database systems gives foreign keys names of their own: keys
  from SQLite are all called `fk_1`, which MySQL and SQL Server refuse twice.
- The table designer edits SQL Server's nonclustered indexes instead of keeping them
  as they are.
- A date and time typed into a cell may have up to nine fraction digits and a space before
  the zone, the way SQL Server's `datetime2(7)` and `datetimeoffset` show them.
- Copying tables reads `CHAR(10 CHAR)`-style lengths and keeps a time default only where
  the target can hold it.

## [0.5.0] - 2026-10-29

Moving data in and out without other tools: SQL files of any size, dumps, imports,
whole-table exports, test data, and copies between connections of any kind.

### Added

- Run SQL File: a script of any size runs statement by statement as it is read, on a
  connection of its own, with progress and cancel. Stop at the first error or go on and
  get a report of every failed statement with its line. `DELIMITER`, MySQL `/*! … */`
  comments and psql commands are understood; `COPY … FROM stdin` is reported.
- Dump to SQL File: tables, a database or a schema — structure, data or both — written in
  one read-only snapshot and ordered to load into an empty database (types, routines,
  sequences, tables, rows, keys, triggers, views, events). Optional `DROP … IF EXISTS`.
- Import Data from File: CSV and JSON (arrays or JSON Lines) into a table, with the
  delimiter and header guessed, a column mapping, a preview of the converted values,
  all-or-nothing or skip-bad-rows modes and a list of every row that did not fit.
- Export Data: every row of a table or view straight from the server to CSV, JSON, SQL,
  Markdown or Excel, with progress and cancel. Exporting a table view writes the whole
  filtered and sorted table; a result cut by the row limit can be read again in full.
- Generate Test Data: a generator per column chosen from its name and type, a NULL
  share, a row count and a seed; insert the rows or open them as SQL.
- Copy to Another Connection: tables with their rows, keys and numbering go to another
  connection, also between MySQL, PostgreSQL and SQLite, with types and defaults
  translated and a report of what could not be carried over.

### Changed

- Queries read rows only as fast as they are used, so a slow consumer no longer makes
  a large result pile up in memory.

### Fixed

- PostgreSQL `E'…'` strings with a backslash-escaped quote no longer confuse the
  statement splitter.
- “New Table…” shows again on the Tables folder of the tree.
- MySQL: a default on a `TEXT`, `BLOB` or `JSON` column is written as an expression, as
  the server requires.
- PostgreSQL `NaN` and `Infinity` are no longer written as `NULL` in generated SQL.

## [0.4.0] - 2026-10-28

Connections for real work: remote and production databases, connections shared
with the team, transactions on your word, and per-connection session settings.

### Fixed

- Editing a connection no longer drops its TLS settings, or its production and
  read-only flags, when it is saved again.
- Saving grid edits in an editor with an open transaction no longer commits that
  transaction: the edits join it and wait for your Commit or Rollback.

### Added

- Project connections: a workspace folder can keep connections in
  `.vscode/datanest.json`, a file without passwords that the team commits. Each person
  keeps their own passwords on their own computer. The project shows above your
  folders in the tree; connections move into it and back, and the editor offers
  completion for the file. Untrusted workspaces list the file but do not use it.
- Transactions: the status bar shows whether the editor has a transaction open (as the
  server reports it) with Commit and Rollback buttons, and switches between auto-commit
  and manual commit, where the first change opens a transaction. DataNest asks before
  MySQL silently commits an open transaction (DDL), before an editor switches connection
  and before a disconnect, and says when a closed editor or a lost link rolled one back.
  New setting `datanest.transactionMode`.
- Session settings per connection: connect timeout (also for SSH hops), query timeout,
  keep-alive, time zone, MySQL character set and init SQL that every new session runs
  first. TCP keep-alive is always on.
- Filter the databases and schemas a connection shows, by ticking them or with patterns
  such as `app_*, !app_test`; the object search follows the same filter.
- Export the connection list to a file (without passwords) and import it on another
  computer, folders included.
- Connect through an SSH tunnel: log in with a password, a private key (with its
  passphrase) or an SSH agent. Secrets stay in the editor's secret storage. The first
  connection to a server shows its key fingerprint to trust, and a changed key is
  refused.
- Jump hosts: pass through up to five SSH servers on the way, each with its own login.
- SSL/TLS for MySQL, MariaDB and PostgreSQL: encrypt only, check the issuer, or check the
  issuer and the host name; your own CA certificate and a client certificate with its key.
  The host name is checked against the real server even through an SSH tunnel.
- Connection URLs: paste `postgres://…`, `mysql://…` or `sqlite:///…` into the form, or use
  “Add Connection from URL…”. TLS parameters such as `sslmode` are understood.
- Production connections: shown in red with a “P” in the tree and a red status bar
  item; every change (a statement, saving grid edits, a structure change) asks first.
- Read-only connections: changing statements are refused before they run, results are
  not editable, and the server session itself is read-only.
- Folders for connections: create, rename and remove them, drag connections (several at
  once) and folders around, or use “Move to Folder…”. Color labels for connections.
- “Import Connections from .env…” finds database URLs and `DB_HOST`/`PGHOST`-style
  variables in the workspace's `.env` files and adds the ones you pick.

### Changed

- The e2e tests open a scratch workspace folder, and a failed CI e2e run repeats its
  failures as an annotation.

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
