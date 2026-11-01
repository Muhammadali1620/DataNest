# Adding a database from another extension

A database that DataNest does not ship can be added by **your own extension**, without
changing DataNest: DataNest exposes a small API, you register a driver, and the database
appears in the connection list, the tree, the SQL editor and the result grid like any
other. (To add a database to DataNest itself, see [Adding a database driver](adding-a-driver.md).)

The API is version **1**. A version only ever gains optional members; a change that would
break a plugin is a new version, and `apiVersion` tells you which one you got.

## Quick start

Declare the dependency in your `package.json`, so DataNest is installed with your extension
and activated before it:

```json
{ "extensionDependencies": ["datanest.datanest"] }
```

Then register the driver when your extension activates:

```ts
import * as vscode from 'vscode';
import type { DataNestApi } from './datanest-api'; // copy src/api/types.ts from DataNest

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const datanest = await vscode.extensions
    .getExtension<DataNestApi>('datanest.datanest')
    ?.activate();
  if (datanest?.apiVersion !== 1) {
    return; // not installed, or a version this plugin does not know
  }
  context.subscriptions.push(
    datanest.registerDriver({
      id: 'acme.duckdb',
      label: 'DuckDB (Acme)',
      fields: ['file'],
      openSession: async ({ file }) => openMyDatabase(file),
    }),
  );
}
```

`registerDriver` returns something you can dispose; put it in `context.subscriptions` and the
driver goes away with your extension. It throws when the id is malformed or already taken.
`registeredDrivers()` lists the ids registered now, e.g. to check that another plugin is there.

The types live in [`src/api/types.ts`](../../src/api/types.ts). The file imports nothing, so
copy it into your project as it is.

## What you write

A driver is an object with an id, a label, the fields the connection needs, and
`openSession`:

| Member | Meaning |
|---|---|
| `id` | Saved in every connection that uses the driver. Lowercase letters, digits, `.`, `-`, `_`, up to 64; start it with your extension's name, e.g. `acme.duckdb`. **Never change it**: connections would lose their driver. |
| `label` | The name in the list of databases. |
| `fields` | Which of `host`, `port`, `user`, `password`, `database`, `file` the connection asks for. |
| `defaultPort` | Offered when the user leaves the port empty. |
| `features` | `databases`, `schemas`, `cancel`: what the driver can do beyond statements. |
| `identifierQuote` | `"` (default), `` ` `` or `[`, for the SQL DataNest writes itself. |
| `openSession(connection)` | Opens one connection; returns a session. |

A session runs statements and reads the structure:

```ts
interface PluginSession {
  execute(sql: string, options?: { rowLimit?: number }): AsyncIterable<PluginEvent>;
  cancel?(): Promise<void>;
  readonly metadata: {
    listDatabases?(): Promise<string[]>;
    listSchemas?(database?: string): Promise<string[]>;
    listTables(scope): Promise<{ name: string; kind?: 'table' | 'view' }[]>;
    listColumns(table): Promise<{ name: string; dataType: string; nullable?: boolean; primaryKey?: boolean }[]>;
  };
  close(): Promise<void>;
}
```

`execute` yields `{ kind: 'columns', columns }` once, then any number of
`{ kind: 'rows', rows }` batches, then `{ kind: 'done', affectedRows? }`. A statement that
returns no rows sends `done` alone. Throw an error to report a failure; give it a `code`
(`'syntax'`, `'permission-denied'`, `'timeout'`, …) and, for a syntax error, a `position`
(the character in the statement) and DataNest points at it in the editor.

## What DataNest does with it

- **The connection**: **DataNest: New Connection (Database from Another Extension)…**, or
  **New Connection** when any such driver is registered. DataNest asks for the fields you
  listed with the editor's input boxes. The password goes to the editor's secret storage and
  is handed to `openSession`; it is never written to a file.
- **The tree, the editor, the grid**: tables and views from `listTables`, columns from
  `listColumns`, queries from `execute`. The grid shows the rows with the usual tools —
  search, sort, filter, copy, export, charts, history, pinning.
- **Plain SQL.** Highlighting, completion and formatting treat your database as standard
  SQL. Paging uses `LIMIT … OFFSET …`.
- **Not offered**: editing the structure, table designer, dumps, copying tables, plans,
  monitoring and accounts. They need knowledge of a database's own dialect that a plugin
  does not give; a plugin that needs them belongs in DataNest itself.

## Values

Cells may be `null`, strings, numbers, booleans, `bigint`, `Date`, `Uint8Array` or plain
objects. DataNest turns them into the grid's own kinds: a `bigint` stays exact, a `Date`
becomes a timestamp, bytes become a binary value, an object becomes JSON, and `undefined`,
`NaN` and infinities become NULL. A row that is longer or shorter than the columns is cut or
padded. For exact decimals, give `{ kind: 'decimal', text: '10.50' }` — the grid's own value.

Everything a plugin returns is checked. A malformed event, a row that is not a list or a
list of columns that is too long fails that statement with an error; it does not crash the
grid.

## Rules

- DataNest runs your code in the editor's extension host, so a plugin that blocks the event
  loop blocks everything. Keep `execute` asynchronous.
- A connection saved for a driver that is not registered — the extension is uninstalled or
  not yet active — stays in the list and reports that the driver is not available.
- Project files (`.vscode/datanest.json`) may hold such connections: `"driver": "plugin"`
  with `"plugin": "acme.duckdb"`.
