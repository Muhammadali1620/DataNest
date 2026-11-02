# Connections

## Kinds of databases

| Kind | Notes |
|---|---|
| MySQL, MariaDB | Also TiDB and Amazon Aurora MySQL, through presets in the form. |
| PostgreSQL | Also CockroachDB, YugabyteDB and Amazon Aurora PostgreSQL. |
| SQLite | A database file on this machine, or on a server through SSH (read-only copy). |
| Microsoft SQL Server | 2016 and newer, and Azure SQL. |
| ClickHouse | Over its HTTP interface (8123, or 8443 with TLS). |
| Oracle | 12.2 and newer, no Instant Client needed. TLS is not supported yet: connect directly or through SSH. |
| Redis | One server, Sentinel or a cluster; Valkey too. |
| MongoDB | One server, a replica set or `mongodb+srv://`; SCRAM, X.509 and LDAP sign-in. |
| Elasticsearch | And OpenSearch; user and password or an API key. |
| Neo4j | A graph database (5.19 or newer) over its HTTP port (7474), queried with Cypher; user and password. Labels are listed as tables and relationship types as views written `[TYPE]`. Statements run one by one, each as its own transaction. |
| Cassandra | Apache Cassandra over the CQL port (9042): one node's address, user and password when sign-in is on, an optional keyspace. The other nodes are reached through that one address, so a tunnel or a container works. Keyspaces are the databases; a table is shown with its partition and clustering columns first. `CONSISTENCY QUORUM` (as in cqlsh) in the editor or in the init SQL sets the level. There is no read-only mode on the server: DataNest refuses the changing statements itself. Rows are changed with CQL, not in the grid, because an UPDATE would also create a row that does not exist. |
| etcd | A key-value cluster (v3) over its HTTP/JSON gateway on the client port (2379); user and password when the cluster has authentication. |
| Apache ZooKeeper | One or several servers (`host:port`, separated by commas; 2181); user and password for the `digest` scheme, a chroot, TLS. |
| Apache Kafka | The bootstrap brokers (`host:port`, separated by commas; 9092); SASL PLAIN or SCRAM with the user and password, TLS. |
| RabbitMQ | The broker and the management plugin's HTTP port (15672, not the AMQP one); a user with the `management` tag, an optional virtual host to show, TLS. |
| libSQL | A libSQL server (sqld, Turso) over HTTP; the address and an auth token. TLS is on for a hosted server (port 443), off for a local one (8080). |
| Grafana Loki | Loki over its HTTP API (port 3100): a user and password are basic authentication, a password alone is a bearer token, and the *Tenant* field is sent as `X-Scope-OrgID`. Address: `loki://host:3100?tenant=acme&token=…` (`lokis://` or `tls=1` for TLS). Queries are LogQL; see [Querying Loki](#querying-loki). |
| InfluxDB | InfluxDB 2.x over HTTP (port 8086): the organization goes in the *Organization* field, the API token in *API token*, and *Bucket* is the one InfluxQL runs on. Address: `influxdb://host:8086/bucket?org=acme&token=…` (`influxdbs://` or `tls=1` for TLS). |

Each driver is loaded the first time you connect to that kind of database, so the ones
you never use cost nothing.

## Filling the form

- **From a URL**: paste `postgres://`, `mysql://`, `sqlserver://`, `clickhouse://`,
  `oracle://`, `redis://`, `mongodb://`, `elasticsearch://`, `libsql://`, `neo4j://`, `cassandra://` or `loki://` URLs (or a JDBC
  `oracle:thin:@…` one) into the field at the top of the form, or run
  **Add Connection from URL…**.
- **From `.env` files**: **Import Connections from .env…** finds `DATABASE_URL`-style
  variables in the workspace and offers each as a connection.
- **From a SQLite file**: right-click a `.db`, `.sqlite`, `.sqlite3` or `.db3` file in the
  Explorer and pick **Open SQLite Database…** (or run it from the Command Palette and pick
  the file). The file's connection is made if there is none yet, connected and shown.
- **Edit**, **Duplicate** and **Delete** are in the connection's context menu.

## Querying Loki

A label is listed as a table and the values of the label are its columns; double-click a value
to open the stream `{label="value"}` in an editor, and open a label to page through the lines
of every stream that has it. Queries are LogQL, and the settings of a query ride in `#`
comments above it:

```
# range: 6h            how far back from now (15m, 1h, 7d); the default is 1h
# start: 2026-11-01T00:00:00Z   and   # end: now-1h     a window of your own
# step: 1m             the resolution of a metric query
# direction: forward   oldest first (the default is newest first)
# limit: 500           lines to read (the row limit of the grid wins when it is smaller)
# tail: 30s            follow the query live for this long (up to 10m), or `forever`
{app="shop"} |= "error"
```

A statement that holds only such comments sets the defaults of the session, and so does the
*Init SQL* of the connection. A log query gives a row per line — `time`, the exact `ns` stamp,
the `labels` of the stream as JSON and the `line`; a metric query gives a row per sample.
Loki hands over at most 5000 lines per query, and DataNest says so when that cut the answer.
`# tail:` follows a query live: lines logged after it starts arrive in the grid as they come, until
the time is up, the row limit is reached or you cancel (what was read stays); `# tail: forever`
has no time limit, so it runs until the row limit, Cancel or the server closing the stream. Add `# range: 5m` to
start with the lines of the last minutes instead of from now. The commands **Set Loki Time Window…**
and **Follow Loki Query Live…** (editor menu and Command Palette) write the `# range:` and `# tail:`
lines for you.
Loki is only read: nothing is written, and no change can be made through this connection.

## SSH tunnels

In the **SSH** section, give the SSH server and sign in with a password, a private key
(with or without a passphrase) or an SSH agent. Up to five jump hosts can stand between you
and the database. The server's host key is checked the way OpenSSH does: the first time you
are asked to trust it, and a changed key is connected to only after a warning and your
choice.

### SSH algorithms

An old server may speak only methods that DataNest does not offer by default (SHA-1 key
exchange, CBC ciphers, `ssh-dss`), and a strict one may allow fewer than the defaults. Open
**SSH algorithms** under the server (each jump host has its own) and write a rule for the
kind of method — key exchange, server host key, cipher, MAC or compression — in the syntax
of OpenSSH's `sshd_config`:

| Rule | Meaning |
|---|---|
| `+diffie-hellman-group14-sha1` | add to the defaults |
| `-aes128-ctr,hmac-sha1` | remove from the defaults |
| `^aes256-ctr` | put first |
| `aes256-gcm@openssh.com,aes256-ctr` | use exactly these, in this order |

Names are checked against what the SSH library supports, and the field offers them as you
type. A rule that lets in a method outside the defaults shows a warning under the field:
allow weak methods only for a server you trust and cannot update. When the handshake finds
no common method, the error says so and points here. The rules apply to the tunnel, to the
connection test and to a SQLite file copied from a server.

### SQLite file on a server

A SQLite database that lives on a server can be opened through SSH: pick **SQLite**, turn on
**Connect through SSH**, and give the path of the file **on the server**. DataNest logs in
(jump hosts and the host-key check work as for a tunnel), copies the file — and its
`-wal` log, if there is one — over SFTP into a private folder of this machine, and opens the
copy.

- The copy is **read-only** and is a snapshot of the moment you connected. Changes made on
  the server afterwards appear when you disconnect and connect again. Nothing you do can reach
  the original, so there is no risk to an application that has the file open.
- The copy is deleted when the last session of the connection closes; anything left behind by
  a crash is swept at the next start.
- A file larger than `datanest.sqlite.remoteMaxSizeMb` (512 MB by default) is refused
  before anything is copied. The server needs an SFTP subsystem, which OpenSSH has by default.
- A file that is not a SQLite database, an empty one, or one that changed while it was
  being copied reports it; connect again.

## Proxies

**Connect through a proxy** sends the connection through a SOCKS5 proxy or an HTTP proxy
that allows `CONNECT`, with a user and password if it wants them. The proxy is given the
server's name and looks it up itself, so names of a private network work. With SSH turned
on as well, the proxy leads to the first SSH server. The proxy password is kept in the
editor's secret storage, like the others.

## Unix sockets

MySQL, MariaDB, PostgreSQL and Redis on this machine can be reached through their Unix
socket instead of a host and port: the socket file (`/var/run/mysqld/mysqld.sock`) or, for
PostgreSQL, the socket directory (`/var/run/postgresql`) — the port then picks the file in
it. On Windows a MySQL named pipe (`\\.\pipe\MySQL`) goes in the same field.

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

- Folders: **New Folder…**, drag and drop, **Move to Folder…**. Folders nest, up to eight levels: **New Subfolder…** on a folder, **Move Folder…** (or drag a folder onto another one), and `Work/Prod` in the Folder field of the connection form puts it in a folder inside a folder. **Remove Folder** lifts what it held one level up; nothing is deleted.
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

Or let the editor carry it: with `datanest.connections.sync` on, the list travels with
**Settings Sync** between your computers. Passwords never do — each computer keeps its own,
so type them once on each — and paths to SQLite files and SSH keys must exist on each.

Every password box of the form has a **Show** button for what you typed; a stored password
is never sent back to the form.
