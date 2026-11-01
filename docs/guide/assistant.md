# The assistant: tools for the language model

In an editor that has a language model (VS Code with Copilot Chat and the like),
DataNest offers the model four tools and a chat participant. Editors without that API
(some forks) simply do not show them. The setting `datanest.ai.enabled` turns all of it
off at once.

## What the model can do

| Tool | What it does |
|---|---|
| List DataNest Connections | Name, driver, default database and flags (production, read-only, switched off) of your saved connections. No passwords, hosts or users. |
| List Tables | The databases, schemas, tables and views of a connection. |
| Describe Table | Columns with types, primary key, foreign keys and indexes. |
| Run Read-only Query | One statement that only reads, at most 100 rows back. |

You can also name a tool in a prompt with `#`, for example `#datanestQuery`.

## What it can never do

- It never gets a password, a host or a user name.
- A query is run only if it is **one** statement and DataNest's read-only check
  accepts it. `INSERT`, `UPDATE`, `DELETE`, DDL, `SELECT … INTO`, `SELECT … FOR UPDATE`,
  data-changing CTEs and anything the check does not know are refused.
- **You approve every query** before it runs; the question shows the statement.
  On a production connection the question says so, and structure reads are asked too.
- A switched-off connection and a non-SQL connection (Redis, MongoDB, Elasticsearch) are refused.
- An answer is at most 100 rows and 20 000 characters; a cell is cut at 200 characters;
  a statement that runs longer than 30 seconds is cancelled.

A function with side effects inside a `SELECT` cannot be seen by the check. For a
database where that matters, mark the connection read-only (the server then refuses
changes itself).

## The `@datanest` chat participant

- `@datanest /schema <connection>` shows the tables and columns.
- `@datanest /query <question>` writes a statement for the question with the chosen
  model, and runs it when it only reads, on a connection that is not production.
- `@datanest /explain <SQL>` explains a statement; nothing is run.

Mention the connection's name in the question; with a single connection it is chosen for you.
