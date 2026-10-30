# Keyboard and accessibility

DataNest follows the editor's theme — light, dark and both high contrast themes — and its
display language (English or Russian). Every page can be used from the keyboard, and
keyboard focus is always visible.

## Editors

| Keys | Where | What |
|---|---|---|
| `Ctrl+Enter` / `Cmd+Enter` | SQL editor | Run the statement under the cursor, or the selection. |
| `Ctrl+Shift+Enter` / `Cmd+Shift+Enter` | SQL editor | Run every statement of the file. |
| `Ctrl+Enter` / `Cmd+Enter` | MongoDB query | Run the statement under the cursor. |
| `Ctrl+Enter` / `Cmd+Enter` | Elasticsearch query | Send the request under the cursor. |
| `F12` | SQL editor | Open the DDL of the table under the cursor. |

All of them can be changed in **Preferences: Open Keyboard Shortcuts**; search for
`datanest`.

## Result grid

The grid is one stop of the `Tab` key. Inside it:

| Keys | What |
|---|---|
| Arrows, `Home`, `End`, `Page Up`, `Page Down` | Move; with `Ctrl` (`Cmd`) to the edge. |
| `Shift` + a move | Extend the selection. |
| `Ctrl+A` | Select everything. |
| `Ctrl+C` | Copy the selection as TSV. |
| `Enter`, `F2` | Edit the cell (`Enter` saves the edit, `Esc` drops it). |
| `Delete` | Set the cell to `NULL`. |
| `Insert` | Add a row. |
| `Ctrl+Delete` | Mark the selected rows for deletion. |
| `Ctrl+S` | Save the pending changes. |
| `Shift+Alt+↑` | Sort by the column of the cell (again: the other way, then as the server returned). |
| `Shift+Alt+←`, `Shift+Alt+→` | Make that column narrower or wider. |
| `F4` | Show the whole value of the cell. |
| `Shift+F4` | Show the row as a form. |
| `F12` | Open the row a foreign key cell points at. |

**Screen readers** hear the grid named after its statement and the cell under the
keyboard as it moves, with its column; new and deleted rows and unsaved changes are said
in words. The row count and the search result are announced when they change.

## ER diagram

The diagram is one stop of `Tab`. Arrows move the picture (`Shift`: further); `]` and `[`
(or `N` and `P`) go to the next and previous table by name and say which one it is; `Enter`
opens its rows; `+`, `-` and `0` zoom in, out and to fit; `Esc` clears the selection.

## Charts

`Tab` to the chart, then the arrows (and `Home`, `End`) step through its labels; each
label's values are shown beside it and read out. `Esc` lets go.

## Query plan

The plan is a tree: arrows move between nodes, `←` and `→` collapse and expand them.
