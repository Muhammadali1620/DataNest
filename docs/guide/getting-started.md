# Getting started

## Install

- **Open VSX** (VSCodium, Cursor, Windsurf and other forks): search for *DataNest* in the
  Extensions view, or open [its page](https://open-vsx.org/extension/datanest/datanest).
- **Any editor**: download the `.vsix` attached to a
  [release](https://github.com/Muhammadali1620/DataNest/releases) and run
  **Extensions: Install from VSIX…** from the Command Palette.

DataNest needs VS Code 1.105 or a fork based on it. It ships no native modules, so the same
package works on Linux, Windows and macOS.

## Connect

1. Open the **DataNest** view in the activity bar.
2. Press **New Connection**. Pick the kind of database, fill in the host, port, user and
   password — or paste a URL such as `postgres://user@host:5432/shop` into the field at the
   top, and the form fills itself.
3. Press **Test connection**. When it answers, press **Save**.

The password goes to the editor's SecretStorage, never to settings or a file. The
connection appears in the tree; expand it to see databases, schemas, tables and columns.
The server's own databases (`information_schema`, `pg_catalog`, …) stay hidden until you
turn on `datanest.showSystemObjects`.

## Look at a table

Right-click a table and pick **Open Table**. The rows come page by
page with the total count; sort by clicking a header, filter with the filter bar.

## Run a query

1. Right-click the connection (or a database) and pick **New Query**. An SQL editor opens,
   bound to that connection — its name is in the status bar.
2. Write a statement and press `Ctrl+Enter` (`Cmd+Enter` on macOS): the statement under
   the cursor runs, or the selection if there is one. `Ctrl+Shift+Enter` runs the whole
   file. The **▶ Run** lens above a statement does the same.
3. The results open beside the editor. Each run is a tab; an error is underlined in the
   editor where the server says it happened.

Any `.sql` file can be bound to a connection: run **Select Connection for Query** in it.

## Next

- [Connections](connections.md): SSH, TLS, folders, production marks, project connections.
- [Writing SQL](sql.md) and [Results and editing](results.md).
- [FAQ and troubleshooting](../faq.md) when something does not work.
