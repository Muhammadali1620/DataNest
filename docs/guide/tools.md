# Tools

## ER diagram

**Show ER Diagram** on a connection, database, schema, the **Tables** folder or chosen
tables draws a box per table with its columns, primary and foreign key marks, and the
keys between tables in crow's foot notation. Tables are laid out automatically — a
referenced table left of the tables that point at it — and can be dragged. Pan, zoom,
find a table, highlight its keys with a click, open its rows with a double click. Show all
columns, key columns only or just the names. **Save SVG** and **Save PNG** keep the colours
of the current theme. From the keyboard: arrows pan, `]` and `[` go from table to table.

## Query plans

**Explain Plan** (editor context menu or Command Palette) shows the plan of the statement
under the cursor beside the editor, as a tree: operation, table and index, condition, cost
and rows. The nodes that take the most time or cost are marked, and warnings point at full
scans, sorts, temporary tables, spills to disk, joins without a condition and estimates
that are far off. **Explain Analyze** runs the statement for the real rows and times —
only statements that read. Works on PostgreSQL, MySQL, MariaDB, SQLite, SQL Server (with
its missing index advice), ClickHouse, Oracle, TiDB, CockroachDB and YugabyteDB.

## Comparing schemas

**Compare Schemas…** on a connection, database or schema compares it (the source) with
another schema of the same kind of database (the target): tables — columns, keys, indexes,
comments — and the definitions of views, routines, triggers and sequences, line by line.
Tick the differences to apply and open the migration script: it creates, alters and drops
in an order that works. The script only opens in an editor bound to the target; it runs
when you run it.

## Comparing data

**Compare Data…** on a table compares its rows with a table of any connection — another
database, even another kind of database — matched by key. You see how many rows are the
same, which differ (changed cells marked) and which are only on one side. Values written
differently by different servers (`10.50` and `10.5`, `true` and `1`, JSON with keys in
another order) count as equal. The sync script inserts, updates and, if you ask, deletes
rows so the target matches.

## Server monitor

**Server Monitor** on a SQL connection shows the server's sessions — who, from where, what
they run, how long and what they wait for (and who blocks them) — refreshed every few
seconds. Cancel a statement or end a session after a question; the monitor's own session is
left alone, and a read-only connection stops nothing. Other tabs list the variables of the
session and the server and the status counters with their change per second.

## Users and privileges

**Users and Privileges** on a connection or database lists accounts and roles with their
flags (locked, expired password, superuser, …), the roles they belong to and their
privileges by level and object. Create, change and drop accounts and roles, set passwords,
lock and unlock, grant and revoke — every change is shown as SQL before it runs, and a
statement with a password is never written to an editor.

## Charts

See [Results and editing](results.md#charts).
