# Database structure

## The tree

A connection opens to databases, schemas, then folders of tables, views, functions,
procedures, triggers, sequences and events — whichever the server has. A table shows its
columns (with type, primary key and `NOT NULL`), indexes, foreign keys and triggers.

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

## Other actions

- **Rename…**, **Empty Table (TRUNCATE)…** and **Drop…** on tables and views; **Drop…** on
  routines, triggers and sequences. Each asks first; on a production connection with the
  connection's name.
- **New Database…**, **Drop Database…**, **New Schema…**, **Drop Schema…** where the server
  has them.
- **Generate SELECT / INSERT / UPDATE / DELETE** writes a statement template for a table.
