# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/).

## [Unreleased]

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
