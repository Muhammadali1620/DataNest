# Writing SQL

## Running

A **New Query** is bound to the connection (and database) you opened it from; the status
bar shows which, and a click there switches it. A saved `.sql` file keeps its connection:
open it again — after a restart too — and it is bound as before. Saving a new query as a
file keeps its connection as well.

- `Ctrl+Enter` (`Cmd+Enter`) runs the statement under the cursor, or the selection.
- `Ctrl+Shift+Enter` runs every statement of the file, one after another.
- The **▶ Run** lens above each statement runs just that one.
- **Cancel Query** (or the button in the results) asks the server to stop. The status bar
  shows how long a statement has been running.
- `datanest.rowLimit` caps how many rows one statement brings back (1000 by default); a cut
  result says so. `datanest.queryTimeout`, or a connection's own timeout, cancels a
  statement that runs too long.

The splitter understands strings, comments, `$$ … $$` bodies, MySQL's `DELIMITER`, SQL
Server's `GO`, procedure bodies and batch variables, so a statement is never cut in the
middle. When a file holds several statements, the one under the cursor is highlighted, and
statements fold like blocks; the `datanest.editor.*` [settings](settings.md#sql-editors)
turn the lenses, the highlight and the folding off.

## Variables

Write `:name` or `${name}` where a value goes, and DataNest asks for it when the statement
runs — each name once, even when it appears in several statements:

```sql
SELECT * FROM orders WHERE customer_id = :customer AND created >= ${since};
```

The value goes in as a literal of the connection's dialect: a number as it is, `NULL`, or
text, quoted for you. Text in single quotes stays text even when it looks like a number
(`'007'`, `'42'`). The statement that ran, with its values, is what the results and the
history show. The value you gave last time is offered next time;
`datanest.queryVariables` can make DataNest just ask, or leave the variables alone.

Strings, comments and quoted names are never searched, and neither are things that only
look like variables: casts (`a::int`), assignments (`@x := 1`), array slices, ClickHouse
parameters (`{id:UInt32}`) and the bodies of routines and triggers (`:new.id`).

### Placeholders

The placeholders of the database itself are asked for in the same way, in the spelling
the dialect uses:

| Database | Placeholder |
|---|---|
| MySQL, MariaDB | `?` |
| SQLite | `?` and `?1` |
| PostgreSQL | `$1`, `$2`, … |
| Oracle | `:1`, `:2`, … |

```sql
SELECT * FROM orders WHERE customer_id = ? AND status = ?;
```

Every `?` is a value of its own (`?1`, `?2`, … — numbered through the whole script), while a
`$1` that appears twice is asked for once. `PREPARE` and `EXECUTE` statements are left
alone: the placeholders in them belong to the server.

## Help while writing

- Completion knows the tables and columns of the connection, aliases, the columns of every
  joined table, CTEs and subqueries, the functions of the dialect and statement snippets.
- Hover over a table or column for its type, keys and comment; `F12` opens its DDL.
- **Format Document** formats in the connection's dialect; the `datanest.format.*`
  [settings](settings.md) choose the style.
- **Generate SELECT / INSERT / UPDATE / DELETE** on a table writes a template.

## Transactions

Each SQL editor commits on its own. In **auto-commit** (the default) every statement is
saved at once. In **manual commit** the first statement that changes data opens a
transaction: the status bar shows it — as the server reports it — with **Commit** and
**Roll Back**. Switch with **Switch Auto-commit / Manual Commit**, or make manual the
default with `datanest.transactionMode`. Switching the editor to another connection, or
disconnecting, while a transaction is open asks first; if the server ends a transaction
(a lost connection), you are told it was rolled back.

## Safe mode

Before a `DELETE` or `UPDATE` without `WHERE`, a `DROP` or a `TRUNCATE`, DataNest asks
(`datanest.safeMode`: `confirm`), refuses (`block`) or just runs (`off`). The same holds
for `FLUSHALL` in Redis, `drop` or `deleteMany({})` in MongoDB and deleting an
Elasticsearch index. On a production connection one question covers both.

## History

**Query History** lists the statements you ran — newest first, with the connection, time,
duration and row count — to search, rerun or copy. Passwords in statements such as
`IDENTIFIED BY '…'` are masked before anything is stored. `datanest.historyLimit` sets
how many are kept; `0` turns the history off.

## Query plans

**Explain Plan** shows the plan of the statement under the cursor; **Explain Analyze**
also runs it (only for statements that read). See [Tools](tools.md#query-plans).

## Compare results

**Compare Results…** (Command Palette) puts two results of this session side by side. Pick
the two results, then the column or columns that identify a row (an `id`, say); pick none
to compare whole rows. DataNest opens the editor's own diff view on two listings with the
rows in matching order, so changed rows line up and rows found in one result only stand
out, and a message gives the counts: the same, different, only in the first, only in the
second. Only the columns both results have are compared (names match regardless of case);
the others are named in the message. Values are compared exactly: `10.50` and `10.5` are
the same number, `a` and `A` are not, `NULL` is not an empty string.

## Notebooks

A **SQL notebook** (`*.sqlnb`, **New SQL Notebook** in the Command Palette) mixes cells of
SQL with cells of Markdown. Run a cell with the usual notebook controls; its result appears
under it as a table (the first 500 rows; the rest stay on the server). A notebook has one
connection, shown in the status bar and the toolbar, and **one session**: a temporary table
or a `SET` in one cell is still there in the next. Variables, placeholders, safe mode and
the production and read-only rules work as in a query editor.

The file holds the cells and the connection, not the results, so it is small and diffs well.
A connection from the project file (`.vscode/datanest.json`) is saved by its id there, so a
teammate who opens the notebook gets the same connection.

## Project queries

**Save Query to Project…** keeps the query you are writing (or the selection) as
`.vscode/datanest-queries/<name>.sql`, next to the project's connections, so it can be
committed and shared. **Open Project Query…** lists them; **Delete Project Query…** removes
one. A query written on a project connection starts with comments that say where it runs:

```sql
-- datanest: connection=staging
-- datanest: database=shop
SELECT …
```

Opening it binds the editor to that connection when you have it. A connection that is not in
the project file is never named in the file.
