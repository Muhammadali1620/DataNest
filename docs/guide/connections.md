# Connections

## Kinds of databases

| Kind | Notes |
|---|---|
| MySQL, MariaDB | Also TiDB and Amazon Aurora MySQL, through presets in the form. |
| PostgreSQL | Also CockroachDB, YugabyteDB and Amazon Aurora PostgreSQL. |
| SQLite | A database file on this machine. |
| Microsoft SQL Server | 2016 and newer, and Azure SQL. |
| ClickHouse | Over its HTTP interface (8123, or 8443 with TLS). |
| Oracle | 12.2 and newer, no Instant Client needed. TLS is not supported yet: connect directly or through SSH. |
| Redis | One server, Sentinel or a cluster; Valkey too. |
| MongoDB | One server, a replica set or `mongodb+srv://`; SCRAM, X.509 and LDAP sign-in. |
| Elasticsearch | And OpenSearch; user and password or an API key. |

Each driver is loaded the first time you connect to that kind of database, so the ones
you never use cost nothing.

## Filling the form

- **From a URL**: paste `postgres://`, `mysql://`, `sqlserver://`, `clickhouse://`,
  `oracle://`, `redis://`, `mongodb://` or `elasticsearch://` URLs (or a JDBC
  `oracle:thin:@…` one) into the field at the top of the form, or run
  **Add Connection from URL…**.
- **From `.env` files**: **Import Connections from .env…** finds `DATABASE_URL`-style
  variables in the workspace and offers each as a connection.
- **From a SQLite file**: right-click a `.db`, `.sqlite`, `.sqlite3` or `.db3` file in the
  Explorer and pick **Open SQLite Database…** (or run it from the Command Palette and pick
  the file). The file's connection is made if there is none yet, connected and shown.
- **Edit**, **Duplicate** and **Delete** are in the connection's context menu.

## SSH tunnels

In the **SSH** section, give the SSH server and sign in with a password, a private key
(with or without a passphrase) or an SSH agent. Up to five jump hosts can stand between you
and the database. The server's host key is checked the way OpenSSH does: the first time you
are asked to trust it, and a changed key is connected to only after a warning and your
choice.

## TLS

Pick how strictly the server certificate is checked: verify it fully, encrypt only, or
off. You can give your own CA certificate and a client certificate with its key. (Oracle:
not yet — use SSH.)

## Production and read-only

- **Production** connections are shown in red, and every change asks first — with the
  connection's name in the question.
- **Read-only** connections refuse changes. Where the server supports it the session is
  read-only too; SQL Server has no such session, so there DataNest alone refuses.

## Organizing

- Folders: **New Folder…**, drag and drop, **Move to Folder…**.
- **Set Color…** puts a colour label on a connection.
- **Filter Databases…** and **Filter Schemas…** show only what you name, with `*`
  wildcards and `!` exclusions: `app_*, !app_test`.

## Per-connection options

The **Session** section of the form holds the connect and query timeouts, keep-alive, the
session time zone, the character set and **Init SQL** — statements run at the start of
every session, after the time zone. For Redis the same place holds **Init commands**.

## Project connections

A connection can live in the workspace file `.vscode/datanest.json` instead of your own
list: **Move to Project Connections…**. The file holds everything but the password, so it
can be committed; each person enters their own password once, and it stays on their
machine. **Open Project Connections File** opens it. In an untrusted workspace project
connections are not used until you trust it.

## Moving connections between machines

**Export Connections…** writes the list (folders, colours, options) to a JSON file —
never with passwords. **Import Connections…** reads it back.
