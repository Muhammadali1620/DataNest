# Results and editing

## The grid

Results open beside the SQL editor, one tab per run (a document keeps its last 20). The
grid draws only the rows on screen, so a result of a million rows scrolls as smoothly as
one of ten; the rows themselves stay in the extension, and the page asks for the ones it
shows. Values keep their precision: a `BIGINT`, a `DECIMAL` or a timestamp is shown,
copied and exported exactly as the server sent it.

- **Sort** by clicking a header: ascending, descending, then the server's order again.
  Sorting covers every row, not just the ones on screen.
- **Find in results** searches every cell of every row; `Enter` and `Shift+Enter` step
  through the matches.
- **Columns**: hide, show and pin columns, drag a header edge to resize, double-click it to
  fit the content.
- **Value panel** (`F4`): long text, pretty-printed JSON, a hex dump of binary data, images
  stored in BLOBs. **Record card** (`Shift+F4`): the focused row as a form.
- A foreign key cell links to the row it points at: `Ctrl+click` or `F12`.
- Spatial values of MySQL and MariaDB show as text — `SRID=4326;POINT(1.5 -2)` — rather
  than bytes. They are shown, not edited.
- The value panel saves a cell to a file (**Save to File…**): a BLOB byte for byte, other
  values as UTF-8 text.

## Selecting and copying

Select with the mouse, or the arrow keys with `Shift` for a range; `Ctrl+A` selects all.
`Ctrl+C` copies the selection as TSV, ready to paste into a spreadsheet. When more than one
cell is selected, the bar above the grid shows how many hold a value and, for numbers, their
sum, average, smallest and largest — exact for integers and decimals, marked `≈` when a
floating-point value is in the mix. **Copy as** offers
CSV, JSON, Markdown, SQL `INSERT` or `UPDATE` statements and an `IN (…)` list.
**Export Result** writes the whole result to CSV, JSON, SQL, Markdown or Excel.

## Editing rows

A result that comes from one table with a primary key (or another way to find a row
again) can be edited in place:

- `Enter` or `F2` (or a double click) edits a cell, with an editor that fits the column —
  a checkbox for booleans, a list for enums, a date for dates. **Set NULL** and
  **Set DEFAULT** are in the edit bar; `Delete` sets `NULL`.
- `Insert` adds a row; **Duplicate** copies the selected ones; `Ctrl+Delete` marks rows for
  deletion (and **Restore** takes the mark off).
- **Load from File…** in the value panel puts a file into a cell: its bytes into a binary
  column, its text into a text or JSON column (up to 16 MB).
- Changes wait, marked in the grid, until you save them: **Preview SQL** shows the
  statements, `Ctrl+S` saves them all in one transaction — on an error nothing is saved
  and the row that failed is shown. **Discard** throws them away.

Each change finds its row by the key and checks that the row is still what you saw, so
someone else's change is never overwritten silently.

A table without a primary or unique key can be edited too when the result shows all of its
columns (the badge says **Editable by values**): a row is found by all its values that
compare exactly — not floating-point numbers, binaries, JSON or large objects. If those
values match more than one row, nothing is saved, and you are told why.

## Tables page by page

**Open Table** shows a table a page at a time (`datanest.pageSize` rows, 200 by default).
Sorting and the filter bar (`column`, operator, value — or your own `WHERE` text) run on
the server, over the whole table. The row count is the server's fast estimate until you
press **Count**; **Load all** reads every row (after a question when there are many).

## Charts

**Chart of Result** (the **Chart** button, or the Command Palette) draws the current
result as lines, bars or a pie in a tab beside it. DataNest guesses the labels and values
from the columns; change the type, the label column, the value columns and how equal
labels are combined (sum, average, count, minimum, maximum). Save the chart as SVG or PNG.
The chart is drawn from a copy of the rows at the moment it was opened.
