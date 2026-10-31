# Database structure

## The tree

A connection opens to databases, schemas, then folders of tables, views, functions,
procedures, triggers, sequences and events — whichever the server has. A table shows its
columns (with type, primary key and `NOT NULL`), indexes, foreign keys and triggers.

Next to each table the tree shows its estimated number of rows, and its tooltip the size
on disk and the table's comment — all from the server's own statistics, never a
`COUNT(*)`, so they are as fresh as the server keeps them (`datanest.tree.tableStats`
turns them off; SQLite keeps none). **Filter…** on a **Tables** or **Views** folder narrows
it for this session: a word finds the names that contain it, and `*`, `?` and `!` work as in
the database filter (`order*, !tmp_*`); an empty filter shows everything again.

The structure is cached: expanding a node twice does not ask the server twice. **Refresh**
on a node reads it again; DataNest also forgets what a statement you ran may have changed.
**Find Database Object…** searches every connected connection for a table, view or
routine by name.

## DDL and definitions

- **Show DDL** opens the `CREATE` statement of any object in a read-only editor.
- **Edit Definition…** opens a view, function, procedure or trigger as SQL;
  **Apply Definition** replaces it safely — checked first, and put back as it was if the
  new one fails.

## The table designer

**New Table…** and **Edit Table…** open the designer: columns (type, length, default,
`NULL`, identity, comment), primary key, indexes and foreign keys. It turns your changes
into `CREATE TABLE` or `ALTER TABLE` statements for the connection's dialect and shows them
before anything runs. Where a database cannot alter something in place (SQLite), the
designer rebuilds the table and keeps its rows.

The **Checks** tab of a stored table lists its `CHECK` constraints with their conditions
(PostgreSQL, MySQL and MariaDB, SQL Server, Oracle and SQLite) and adds or drops one.
Oracle leaves out the `NOT NULL` of columns, which it counts as checks. SQLite has no
`ALTER` for a constraint: a check is read from the table's own `CREATE TABLE` text, one
without a name is called `unnamed_check_1`, `unnamed_check_2`… in order, and adding or
dropping one rebuilds the table (a copy, the rows copied over, the old table dropped, the
copy renamed, indexes and triggers created again). The whole script is shown first and
rolled back if a row breaks the new condition.

## Other actions

- **Duplicate Table…** makes a copy beside the table under a new name — structure and rows,
  or the structure alone. The server copies the rows itself; indexes and keys get names of
  their own, a key to the table itself points at the copy, and numbering goes on after the
  copied rows.
- **Rename…**, **Empty Table (TRUNCATE)…** and **Drop…** on tables and views; **Drop…** on
  routines, triggers and sequences. Each asks first; on a production connection with the
  connection's name.
- **New Database…**, **Drop Database…**, **New Schema…**, **Drop Schema…** where the server
  has them.
- **Generate SELECT / INSERT / UPDATE / DELETE** writes a statement template for a table.
