# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [1.6.0] - 2026-10-31

### Added

- Tools: QR code (read and create), Task manager, Settings, crop, compress (on this machine or TinyPNG), SVG designer, public IP, DNS over HTTPS, ICMP ping, 20 colour previews; the page remembers its tab.
- Manager dashboard: live traffic and query charts.
- Server version after the connection name and size after the schema name in the tree (`datanest.tree.showSizes`).
- Red asterisk on NOT NULL columns in result headers.

### Changed

- Pages of a table switch in the same tab with a fixed bar.
- Recognisable database marks (simple-icons, CC0; the marks stay trademarks of their owners).

## [1.5.0] - 2026-10-31

### Added

- Manager page: log, dashboard, process list, dump and structure sync.
- Own drawn marks of every database in the connection form and the tree; colourful tab and header icons.
- Red asterisk on required fields.
- Move column up/down for every SQL database (a rebuild script for review where the engine cannot reorder).

### Changed

- The table bar is on every table page and switches pages in the same tab; no overflow menu.
- ER diagram from a table shows the whole schema with the camera on that table.
- Dump moved into the Manager.

### Fixed

- Double click on a table no longer flashes its folders.

## [1.4.0] - 2026-10-31

### Added

- Results: table bar (Properties, Data, ER diagram, test data, compare, history), AND/OR filters, Refresh and Tools buttons, custom page size, richer value panel with XML and JSON colouring and paired brackets, own context menus.
- Tree: Columns/Indexes/Foreign Keys/Triggers folders with counts, DDL on double click of a column, index, key or trigger, Query and Security nodes, column move up/down, per-kind icons.
- Table properties: DDL, Triggers and Checks tabs with counts.

- Checks tab for Oracle and SQLite.

### Changed

- Double click on a table opens only its data. Defaults: text left, grid lines. The "indexes kept as they are" notice is gone.

### Fixed

- SQLite table rebuild kept no CHECK constraints, STRICT or WITHOUT ROWID.
- Properties and tools on a view result page failed.
- Page arrows did not work on a single page.

## [1.3.0] - 2026-10-31

### Added

- Results: a form to insert a row (the Add row button stays), an up and a down arrow and
  a funnel on every column header (filter by a value or a condition), an arrow before
  every row that opens its fields top to bottom under it, a button on a foreign key cell
  that opens the related row (Ctrl+click still works), JSON typing like the editor in the
  value dialog (brackets and quotes pair, Enter indents, Tab), view as JSON or reversed,
  dragging columns by the header, a font choice, four kinds of lines, a row height stepper
  and an option to hide the execution time.
- Tools: a page of small local utilities, opened with "DataNest: Open Tools" (or the
  tools button in the results toolbar). General: MD5, SHA-1 and SHA-256 of a text, Base64,
  URL and Unicode encoding, random names, passwords and UUIDs, a Unix time converter.
  Network: interfaces, a TCP port check, DNS lookup and a TCP ping. Colors: a picker with
  derived shades and a live preview. Image: resize, to Base64 and an SVG editor. Nothing
  is sent to any service.

## [1.2.0] - 2026-10-31

### Added

- Results: the statement is above the table and can be edited and run in place with
  Ctrl+Enter (Cmd+Enter on a Mac).
- Results: check boxes on rows, for actions on several rows at once.
- Results: a magnifier on a cell opens its value in a dialog (text or JSON, format,
  compact, copy, load from and save to a file).
- Results: a View menu (row height, text size, lines, alignment, row numbers, check
  boxes) and automatic refresh every few seconds.
- Export: a dialog to export these rows, the whole table or every table of the
  database; an Import button on a table.
- The tree draws tables and views with their own coloured icons.

### Changed

- Results: bigger text and rows, the type under every column name, the row actions as
  icons under the toolbar, paging in the toolbar, rounder fields and buttons.

### Fixed

- Sorting or paging a table could move its results into a new split; the panel now
  stays where it is.

## [1.1.0] - 2026-10-31

### Changed

- Open a table from the tree with a double click; the button next to its name is gone.
- Brighter, rounder look: icon buttons in results have their own colours and rounded
  shapes, result tabs and the search box are pills, column type icons and the tree's
  icons are coloured by kind.
- A new look for every page, made to feel like part of the editor in any theme: the
  editor's icons, toolbars of icon buttons with tooltips, menus you can work with the
  keyboard, cards, badges and notices, check boxes like the editor's own, and short
  animations that stop when the system asks for reduced motion.
- Results: tabs like the editor's panels, one toolbar with search, filter, columns,
  value, record, chart, Copy as and a single Export menu, a status bar with the row
  count, edit state and paging, a type icon in every column header, striped rows, and
  clear empty, error and unsaved-changes states.
- Connection form: pick the database from cards, with compatible servers grouped below;
  the fields are grouped into sections, and Test and Save stay at the bottom of the page.
- Every page's tab has its own icon, and the tree's context menu groups Generate SQL and
  the data commands (dump, export, import, test data, copy, compare) into submenus.
- The empty Connections view also offers to open a SQLite file.
- Table designer, import, test data and users: the same clean form layout, with icon
  buttons, tab badges, examples only where you type, and a pinned bar with progress.
- ER diagram, chart, query plan and server monitor: tool pages with icon toolbars and a
  status bar; the diagram gets a grid, card-like tables and a legend, the monitor gets
  metric tiles with a queries-per-second sparkline.
- Schema and data compare, Redis, MongoDB and Elasticsearch pages: differences marked with
  a sign as well as a colour, a terminal-like Redis console, side panels for editing.

### Fixed

- The `datanest.format.*` settings are read for the document being formatted, so a folder of
  a multi-root workspace can keep its own SQL style; before, the folder's value was ignored
  and the editor logged a warning on every Format Document.
- Every page (connection form, results, table designer and the rest) gets its shared styles
  again: the build had moved them into files no page loaded, so in the editor fields and
  buttons fell back to the browser's own look and help meant only for screen readers showed
  on screen.
- The results table shows its first row — it was drawn under the header — and the header
  stays at the top while the rows scroll.

## [1.0.0] - 2026-10-31

DataNest 1.0: everything the most used database extension of the editor offers for working
with databases — and more — free, with no account and no telemetry. Measured against its
public feature list ([the checklist](docs/research/v10.1-parity-checklist.md)), the gaps
are closed: variables in queries, proxies and Unix sockets, editing tables without a key,
finding data across a database, documenting it, and the database's own command-line client.

### Added

- Query variables: write `:name` or `${name}` where a value goes, and DataNest asks for it
  when the statement runs, offering the value given last time
  (`datanest.queryVariables`). Values go in as literals of the connection's dialect.
- A saved `.sql` file remembers its connection and database: open it again, after a restart
  too, and it is bound as before. A new query saved as a file keeps its connection.
- The statement under the cursor is highlighted when a file holds several, and SQL folds by
  statements, block comments, `-- #region` markers and indentation. Settings
  `datanest.editor.codeLens`, `datanest.editor.highlightStatement` and
  `datanest.editor.foldStatements` turn the Run lenses, the highlight and the folding off.
- The tree shows each table's estimated rows, and its size and comment in the tooltip, from
  the server's own statistics (`datanest.tree.tableStats`). **Filter…** narrows a long
  Tables or Views folder.
- **Duplicate Table…** copies a table beside itself, with or without its rows; the server
  copies the rows, and keys, indexes and numbering follow the copy.
- **Open SQLite Database…** on `.db`, `.sqlite`, `.sqlite3` and `.db3` files in the Explorer.

- Totals of the selected cells above the grid: count, and for numbers sum, average, minimum
  and maximum — exact for integers and decimals.
- Tables without a key can be edited when the result shows all their columns: rows are found
  by their values, and nothing is saved when those match more than one row.
- The value panel saves a cell to a file and loads a file into a cell — a BLOB, a long text,
  a JSON document.
- MySQL and MariaDB spatial values show as WKT (`SRID=4326;POINT(1 2)`) instead of JSON.

- Connections through a SOCKS5 or HTTP proxy, with a user and password; with SSH, the proxy
  leads to the first SSH server.
- Unix sockets for MySQL, MariaDB, PostgreSQL and Redis on this machine.
- A **Show** button on every password box of the connection form.
- `datanest.connections.sync` lets the connection list travel with Settings Sync; passwords
  stay on each computer.

- **Find Data…**: a text in every text column of every table of a database or schema, by
  table and column; a hit opens the table filtered to its rows.
- **Document Database…**: tables, columns, keys, indexes, references and definitions as one
  Markdown document.
- **Open in Terminal**: the database's command-line client (`mysql`, `psql`, `sqlite3`,
  `sqlcmd`, `redis-cli`, `mongosh`, …), through the tunnel or proxy, the password in its
  environment variable.

- MongoDB **Export Documents…** and **Import Documents…**: canonical Extended JSON, one
  document per line; files of `mongoexport` load too.
- Elasticsearch: **Copy as cURL** without secrets, **Show Settings** of an index, and
  templates of the usual requests in a new query to an index.

### Changed

- Copying tables between schemas of one database now runs on one session and lets the
  server move the rows, instead of streaming them through the editor.

## [0.9.0] - 2026-10-30

The public beta: faster with big results, fully in Russian, usable from the keyboard and
with a screen reader, documented — and a way to tell us what does not work.

### Added

- The result grid works with screen readers: it is one stop of the Tab key, the cell under
  the keyboard is read out as you move, and new, deleted and changed rows and cells are
  said in words. `Shift+Alt+↑` sorts by the column of that cell, `Shift+Alt+←` and `→`
  change its width.
- The ER diagram can be used from the keyboard: arrows move the picture, `]` and `[` go
  from table to table and say which one, `Enter` opens it.
- A chart's values can be read with the arrow keys, by a screen reader too.
- Documentation: a user guide to every feature, the keyboard shortcuts and all settings, a
  FAQ with fixes for common connection problems, and a guide to adding a database driver
  ([docs](https://github.com/Muhammadali1620/DataNest/blob/main/docs/index.md)).
- **Report a Problem…** (Command Palette, or the "…" menu of the Connections view) opens
  the bug form on GitHub with the DataNest, editor and system versions filled in —
  nothing about your connections.
- Keyboard focus is visible on every page, and in high contrast themes selections and
  changes are outlined instead of shown by a background that the theme leaves dark.

### Fixed

- Sorting a result of a million rows by a text column took over a minute — 85 seconds for
  distinct names, 50 for dates — and the editor's extensions froze meanwhile; the page
  even gave up waiting after 30 seconds. Now numbers and dates sort in about a second and
  distinct text in several, and DataNest keeps answering while it sorts. The order is the
  same as before.
- Quick search in a big result ran on every key press and held the extensions for about
  a second each time; a search now runs in slices, a newer one stops the one still running,
  and the answer to old text no longer replaces the answer to what you typed last.
- Results of all editors together keep at most twenty million cells: twenty runs of a
  million rows could exhaust the memory of the extension host. The oldest results go
  first; the newest one and results with unsaved changes are always kept.

- In a Russian editor, about 380 messages of DataNest's own services and drivers still came
  in English: connection errors, timeouts in the history, refusals of the Redis console,
  mistakes in MongoDB statements and JSON, name checks, import, transfer, saving edits,
  SSH and TLS problems. They are translated now; only what the servers themselves say
  stays as they say it.
- Numbers in the tree and in questions are grouped the way the editor's language writes
  them, not the operating system's.
- An import that lost its connection no longer tries to move the table's sequence
  afterwards, which added a second, confusing failure to the report.
- Searching a big result again for the same text no longer flashes "no matches" for a
  moment.

### Changed

- The DataNest log says how long the extension took to start.

## [0.8.0] - 2026-10-30

Tools: an ER diagram, visual query plans, schema and data comparison with scripts, a server
monitor, users and privileges, and charts of query results.

### Added

- ER diagram of a database, schema or chosen tables: a box per table with its columns,
  primary and foreign key marks, and the keys between tables in crow's foot notation.
  Tables are laid out automatically — a referenced table left of the tables that point at
  it — and can be dragged; pan, zoom, find a table, highlight its keys, open its rows with
  a double click. Show all columns, key columns only or just names. Save the diagram as
  SVG or PNG in the colours of the current theme.
- Visual query plans: "Explain Plan" on the statement under the cursor opens its plan
  beside the editor as a tree — operation, table and index, condition, cost, rows — with
  the nodes that take the most time or cost marked, and warnings for full scans, sorts,
  temporary tables, spills, joins without a condition and estimates that are far off.
  "Explain Analyze" runs a reading statement for the real rows and times. Works on
  PostgreSQL, MySQL, MariaDB, SQLite, SQL Server (with its missing index advice),
  ClickHouse, Oracle, TiDB, CockroachDB and YugabyteDB.
- Schema comparison: compare two databases or schemas of the same kind and see what is
  new, different or only in the target — columns, keys, indexes and comments of tables,
  and the definitions of views, routines, triggers and sequences line by line. Tick the
  differences to keep and open a migration script in an editor on the target: it creates,
  alters and drops in an order that works, and runs only when you run it.
- Data comparison: compare the rows of two tables — in one database, two databases or
  two kinds of database — matched by key: how many are the same, which differ (with the
  changed cells marked), which are only on one side. Values spelled differently by
  different servers count as equal. A sync script inserts, updates and, if asked,
  deletes rows so the target matches, with values made to fit the target's columns.
- Server monitor: the sessions of a server with what each runs, how long and what it waits
  for (and who blocks it), longest first, refreshed every few seconds; cancel a statement
  or end a session after a question. The variables of the session and of the server with
  units, descriptions and the changed ones marked, and the status counters with their
  change per second; uptime, connections and queries or transactions per second at the
  top. On MySQL, MariaDB, PostgreSQL, SQL Server, ClickHouse, Oracle, TiDB, CockroachDB
  and YugabyteDB; a SQLite file shows its pragmas.
- Users and privileges: the accounts and roles of a server with what each may do — on the
  server, a database, a schema, a table, through roles. Make an account, change its
  password, lock it, grant and revoke privileges and roles, drop it; every change shows
  its SQL first (passwords hidden) and runs only when you say so, or opens in an editor.
  On MySQL, MariaDB, PostgreSQL, SQL Server, ClickHouse, Oracle, TiDB, CockroachDB and
  YugabyteDB.
- Charts of query results: "Chart" beside a result draws it as lines, bars or a pie —
  labels from a date or text column, values from the number columns, one point per row or
  rows of one label summed, averaged, counted or taken at their minimum or maximum. A
  line over dates spaces them by time; a pie folds its smallest slices into "Other". The
  values show under the pointer; save the chart as SVG or PNG in the theme's colours.

### Fixed

- A MySQL or MariaDB statement no longer waits forever when the server ends its session
  (an administrator's KILL, a restart); it fails at once, and so do the next ones.

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
