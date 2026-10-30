# Adding a database driver

This guide walks through adding a new SQL database to DataNest. It is the path every
existing driver took; read [ARCHITECTURE.md](../../ARCHITECTURE.md) first for the layers and
the rules, and look at an existing driver of a similar database while you go —
`src/drivers/postgres/` and `src/drivers/sqlite/` are the most complete.

Redis, MongoDB and Elasticsearch are separate families with interfaces of their own
(`src/drivers/redis-driver.ts`, `src/drivers/mongo-driver.ts`,
`src/drivers/elastic-driver.ts`); a new non-SQL database needs a family like them and is a
bigger change. Discuss it in an issue first.

## Ground rules

- **Pure JavaScript only.** DataNest runs unchanged in VS Code and its forks on every
  platform, so a client library with a native add-on cannot be used. Optional native parts
  of a library are replaced by stubs at build time (`NATIVE_OPTIONALS` and
  `UNUSED_MODULES` in `scripts/build-config.mjs`).
- **Clean-room.** Never copy code, texts or icons from other database extensions.
- **No `vscode` in drivers.** `src/drivers/` may import `src/core/` and `src/shared/`, and
  the linter enforces it.
- **Exact values.** A `BIGINT`, `DECIMAL`, timestamp or binary value must reach the grid,
  the clipboard and files exactly as the server sent it.
- **Tests in the same change**, under `test/` only — see [Tests](#tests).

## 1. Name the driver

Add the id to `DRIVER_IDS` in `src/shared/connection.ts`, and its default port to
`DEFAULT_PORTS`. TypeScript will now fail wherever a table needs an entry per driver —
that list is your to-do list. It includes:

- `src/core/sql/keywords.ts`, `src/core/sql/functions.ts`, `src/core/sql/snippets.ts` —
  completion;
- `src/core/sql/tokenizer.ts` and `src/core/sql/identifiers.ts` — how statements are split
  and identifiers quoted;
- `src/core/model/system-objects.ts` — the server's own databases and schemas, hidden by
  default;
- `src/shared/table-design.ts` — the types the table designer offers;
- the connection form, `webview/src/apps/connection-form/App.svelte`.

## 2. Write the driver

Create `src/drivers/<id>/index.ts` that exports `driver`, a `Driver` from
`src/drivers/driver.ts`:

```ts
export const driver: Driver = {
  id: 'mydb',
  dialect: mydbDialect,
  capabilities: {
    databases: true,
    schemas: false,
    databaseScopedSessions: true,
    cancel: true,
    transactions: true,
    objectKinds: ['function', 'procedure'],
  },
  openSession: openMydbSession,
};
```

The build finds it by itself (`findDriverEntries` in `scripts/build-config.mjs`) and writes
`dist/drivers/<id>.js`, which `src/drivers/registry.ts` loads on the first connection to
that database. A driver that needs a worker thread puts it in `src/drivers/<id>/worker.ts`.

The usual files of a driver, each with a matching test in `test/unit/drivers/<id>/`:

| File | What it does |
|---|---|
| `session.ts` | `openSession`: connect (SSH and TLS are already resolved in the config), `execute` as a stream of events, `cancel`, `close`, `transactionState`. |
| `values.ts` | Server values → `CellValue` (`src/shared/cell-value.ts`), exactly. |
| `errors.ts` | Native errors → `DbError` (`src/core/errors.ts`) with the right code, the position in the SQL and the SQLSTATE. |
| `dialect.ts`, `quote.ts` | `Dialect`: quoting, literals, paging, transactions, and the `ddl` and `dump` parts. |
| `metadata.ts` | `MetadataReader`: databases, schemas, tables, columns, keys, indexes, objects, definitions. |
| `ddl.ts`, `alter.ts` | `CREATE` and `ALTER TABLE` for the table designer and schema comparison. |
| `dump.ts` | What a dump needs: snapshot statements, `INSERT` batches, sequences. |

### Executing statements

`execute(sql, { rowLimit })` returns an async iterable of events: `columns` once per result
set, `rows` in batches, `message` for server notices, and `done` with the affected row
count. Read rows as a stream and stop at the row limit; never collect a whole result first.
`cancel()` must stop the running statement on the server.

### Messages

Text the user reads that comes from DataNest itself — not from the server — goes through
`msg()` from `src/core/user-message.ts`, with a single-quoted English template and `{0}`
places, so it can be translated:

```ts
throw new DbError('unsupported', msg('MyDB has no schemas inside a database'));
```

Add the Russian text to `l10n/bundle.l10n.ru.json`; a test fails until you do. Pass the
server's own messages on as they came.

## 3. Optional features

Several tools ask the server things in its own way. Each falls back gracefully when a
database is not listed, so add yours when you can:

- query plans — `src/services/explain/explain.ts`;
- the server monitor — `src/services/monitor/`;
- users and privileges — `src/services/users/user-admins.ts`;
- copying tables between databases — the type map in `src/services/transfer/type-map.ts`;
- the formatter's dialect — `src/services/sql-format.ts`;
- URLs in the form and in `.env` files — `src/shared/connection-url.ts` and
  `src/services/env-import.ts`.

## 4. The connection form

The form (`webview/src/apps/connection-form/`) shows the fields a driver needs. Give the
driver its name in both dictionaries, `webview/src/l10n/en.ts` and
`webview/src/l10n/ru.ts` (`form.driver.<id>`).

## Tests

- **Unit tests** in `test/unit/drivers/<id>/`, one file per module, without a server:
  values, errors, the dialect's SQL, metadata queries against a fake session.
- **Integration tests** against a real server in Docker:
  1. add a service to `docker/compose.yml` — container `datanest-<id>`, a host port in
     7000–7999 bound to `127.0.0.1`, and a `profiles` group;
  2. describe the group in `test/helpers/integration-groups.ts`;
  3. put the tests in `test/integration/<group>/`, named `*.int.test.ts`;
  4. add the group to the `integration` matrix in `.github/workflows/ci.yml` (a repository
     test checks that every compose group is there).

  Run them with `npm run db:up -- <group>` and `npm run test:integration`; stop the
  servers with `npm run db:down`.
- Check that values survive the round trip — numbers at their limits, dates with and
  without time zones, binary data, `NULL` — as the existing `value-fidelity` tests do.

## Before you open a pull request

`npm run lint`, `npm run typecheck`, `npm test` and the integration tests of your group pass.
Add the database to `README.md`, to the table in
[Connections](../guide/connections.md#kinds-of-databases) and to `CHANGELOG.md`.
