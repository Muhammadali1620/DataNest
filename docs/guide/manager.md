# Manager

**Manager** is one page per SQL connection with five sections on the left. Open it from
the connection, database, schema or table in the tree (**Manager**), from the bar of a
table page, or from **Dump to SQL File…**, which opens it on the Dump section.

## Log

Every statement you ran on the connection, oldest first, like a console: the time, the
statement, then how many rows it retrieved or affected and how long it took. A failed
statement is red and shows the server's message. Filter by words, show errors only, copy the
visible lines, or clear the log (it asks first; the statements are removed from the query
history too). The log follows new statements as they finish.

## Dashboard and Processes

The server's version, uptime, connections, size and queries (or transactions) per second
with a trend line, and the full list of status values; and the list of sessions with
filter, sorting and **Cancel statement** / **End session** (it asks first). They are the
[server monitor](tools.md#server-monitor) inside the Manager. A SQLite file has no other
sessions, so it has no Processes section.

## Dump

Writes a SQL script of the chosen tables and views — and, if you tick it, the routines,
events, sequences and types of the scope. Pick the database and schema, tick what goes
in, choose **Structure and data**, **Structure only** or **Data only**, and whether each
`CREATE` is preceded by `DROP … IF EXISTS`. The output file may contain `{data_source}`
(the name of what is dumped) and `{timestamp}`; a name without a folder goes to the
workspace folder. The progress is shown while it runs and **Cancel** stops it, leaving no
half-written file. DataNest writes the script itself, so `pg_dump` and `mysqldump` are not
needed.

## Structure Sync

Pick the reference (the schema to follow) and the target (the schema to change) among the
connections of the same kind of database, then **Compare**. The comparison is the
[schema comparison](tools.md#comparing-schemas) page inside the Manager: the differences,
the detail of each, and the script that makes the target like the reference, opened in an
editor on the target.
