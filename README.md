# DataNest

[![CI](https://github.com/Muhammadali1620/DataNest/actions/workflows/ci.yml/badge.svg)](https://github.com/Muhammadali1620/DataNest/actions/workflows/ci.yml)

A free, open-source database client for VS Code and its forks — MySQL, MariaDB,
PostgreSQL and SQLite, without accounts, limits or telemetry.

**Install:** [Open VSX](https://open-vsx.org/extension/datanest/datanest) —
or from the `.vsix` attached to a [release](https://github.com/Muhammadali1620/DataNest/releases).

<!--
  Screenshots go here before the Marketplace release. They have to be captured by
  hand in a real editor; see docs/test-plan.md for the walkthrough they come from.
  Expected files: docs/images/tree.png, docs/images/query.png, docs/images/grid.gif
-->

## What it does

**Connections**

- MySQL, MariaDB, PostgreSQL and SQLite, each driver loaded only when you first use it.
- A form with “Test connection”, editing, duplicating and deleting.
- Passwords live in the editor's SecretStorage, never in settings or a file.

**Browsing**

- A tree from the connection down to the columns, with type, primary key and `NOT NULL`.
- Structure is cached, so expanding a node twice does not ask the server twice.
- The server's own databases and schemas are hidden until you ask for them.
- “Open Table” shows a table page by page with the total row count.

**Writing SQL**

- Queries run in a normal editor tab, so your keybindings, themes and extensions work.
- `Ctrl+Enter` runs the statement under the cursor or the selection,
  `Ctrl+Shift+Enter` runs the whole file, and a “▶ Run” lens sits above every statement.
- The statement splitter understands strings, comments, `$$ … $$` and MySQL's `DELIMITER`.
- Completion offers dialect keywords, tables and columns, including after `alias.`.
- A running query shows its elapsed time and can be cancelled.

**Results**

- A virtualized grid: a hundred thousand rows cost the same as a hundred.
- Sorting by clicking a header, and a search that looks through the whole result.
- Select cells with the mouse or the keyboard and copy them as TSV, ready for a spreadsheet.
- “Copy as” CSV, JSON, Markdown, SQL `INSERT`/`UPDATE` or an `IN (…)` list, and export
  the whole result to CSV, JSON, SQL, Markdown or Excel.
- Hide and pin columns, fit widths to the content, and look at long text, JSON,
  hex dumps and BLOB images in a value panel.
- Values keep their precision: a `BIGINT` or a `DECIMAL` is never rounded on the way
  to the screen, to the clipboard or into a file.

**Editing data**

- Edit cells in place with editors that know the column type, set `NULL` or `DEFAULT`,
  add, duplicate and delete rows.
- Changes wait in a queue: preview the SQL, undo, and save them in one transaction.
- A record card shows one row as a form; a foreign key cell opens the row it points at.
- Tables filter, sort and page on the server, with a fast estimated row count.

**Safety and history**

- Safe mode asks before `DELETE` or `UPDATE` without `WHERE`, `DROP` and `TRUNCATE`.
- Every statement goes to a searchable history, with passwords masked, ready to rerun.

## Getting started

1. Open the DataNest view in the activity bar.
2. Press **New Connection**, fill in the form and press **Test connection**.
3. Save it, expand the connection, and open a table — or press **New Query** and write SQL.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `datanest.rowLimit` | `1000` | Rows one statement may bring back. |
| `datanest.pageSize` | `200` | Rows on one page when a table is opened from the tree. |
| `datanest.queryTimeout` | `0` | Seconds before a statement is cancelled; `0` means no limit. |
| `datanest.showSystemObjects` | `false` | Show the server's own databases and schemas. |
| `datanest.historyLimit` | `500` | Statements kept in the query history; `0` turns it off. |
| `datanest.safeMode` | `confirm` | Before a destructive statement: `confirm`, `block` or `off`. |
| `datanest.logLevel` | `info` | How much goes to the DataNest output channel. |

## Privacy

DataNest sends nothing anywhere. There is no telemetry, no account and no cloud
service: the extension talks only to the databases you configure. Passwords are
kept in the editor's SecretStorage, and the log masks anything that looks like a
password or a token.

## Requirements

VS Code 1.105 or newer, or a fork based on it (VSCodium, Cursor, Windsurf,
Antigravity, …). No native modules are used, so the same build works on Linux,
Windows and macOS.

## Development

Requirements: Node.js 22+, npm, Docker (for integration tests).

```sh
npm install
npm run build          # build the extension
npm test               # unit tests
npm run db:up          # start the test databases (ports 7000–7999)
npm run test:integration
npm run test:e2e       # smoke tests in a real VS Code
```

Press `F5` in VS Code to launch the Extension Development Host.

Architecture and contribution rules: [ARCHITECTURE.md](ARCHITECTURE.md).
Plan and progress: [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
