# Import, export and transfer

## Running SQL files

**Run SQL File…** runs a script of any size — a dump of many gigabytes included — reading
it a piece at a time, so it never sits in memory whole. Progress shows the bytes and
statements done; you choose to stop at the first error or carry on, and the report lists
every statement that failed with its line. `psql` and SQL\*Plus commands that only set up
the client are skipped and listed.

## Dumps

**Dump to SQL File…** on a table, a database or a schema writes a `.sql` script: structure,
data or both. Everything is read in one consistent snapshot where the server allows it,
and ordered to load into an empty database — tables before their foreign keys, functions
before the views that use them. Binary values are written in full.

## Importing CSV and JSON

**Import Data from File…** on a table reads a CSV file — choose the delimiter, whether the
first row holds column names, how `NULL` is written and whether an empty field is `NULL` —
or a JSON file of records. Map file columns to table columns (or leave one to the
database's default), look at a preview of the values *as they will be stored*, and import
in batches. You choose what a row that does not fit does: stop and keep nothing, skip it
and keep the rest, or stop and keep the rows before it. The report lists every bad row
with its line and the reason.

## Exporting a whole table

**Export Data…** on a table, or **Export Result**, streams every row from the server to
CSV, JSON, SQL `INSERT` statements, Markdown or Excel — however large the table, not just
the rows loaded on screen.

## Test data

**Generate Test Data…** fills a table with rows that fit each column: names, e-mail
addresses, cities, prices, dates, enum values, unique values where a key needs them, and
keys that exist in the referenced table. A seed makes the same data again.

## Copying tables to another connection

**Copy to Another Connection…** copies tables — structure, rows or both — to another
connection, even another kind of database. Types, defaults and keys are translated; the
report says what could not be.

## Comparing data

**Compare Data…** compares the rows of two tables by key — see
[Tools](tools.md#comparing-data).
