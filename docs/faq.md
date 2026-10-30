# FAQ and troubleshooting

## About DataNest

**Is it really free? Are there limits?**
Yes, and no. There is no paid edition, no account, no limit on connections or rows, and no
telemetry: DataNest talks only to the databases you configure.

**Which editors does it work in?**
VS Code 1.105 or newer and forks based on it — VSCodium, Cursor, Windsurf and others — on
Linux, Windows and macOS. It uses no native modules, so one package works everywhere.

**Where are my passwords?**
In the editor's SecretStorage (the system keychain where there is one), never in settings
or files. Exported connection lists and project connection files never contain them. The
log masks anything that looks like a password or a token.

**Which databases are supported?**
See [Connections](guide/connections.md#kinds-of-databases). Others — DuckDB, Amazon
Redshift, Snowflake, Cassandra — are on the list of ideas; DuckDB waits for a client
without native code.

**Can I use it in Russian?**
Yes: DataNest follows the editor's display language. Run **Configure Display Language**
and pick Russian.

## Results

**Why does my query stop at 1000 rows?**
That is `datanest.rowLimit`, which keeps a careless `SELECT *` from filling the memory; a
cut result says so. Raise the setting (up to a million), or open the table with
**Open Table**, which pages through all of it.

**Why are numbers like `9007199254740993` shown exactly?**
On purpose: `BIGINT` and `DECIMAL` values are kept as text all the way, so they are never
rounded the way JavaScript numbers would be.

**Sorting a big result takes a while.**
A result is sorted over all its rows. A million rows of numbers or dates take about a
second, a million different texts several seconds (text is compared the way a person reads
it); the editor keeps working meanwhile. A table opened with **Open Table** is sorted by
the server instead.

## Connecting

**"Cannot connect" or a timeout.** Check the host and port, and that the server accepts
connections from your machine. For a server inside a private network use an SSH tunnel
(the **SSH** section of the form). The connect timeout is in the **Session** section.

**"The server certificate is not trusted".** The server's certificate was issued by a
certificate authority your system does not know: choose its CA certificate in the **TLS**
section, or pick encryption without checking.

**"TLS failed: the server may not speak TLS on this port".** The server does not use TLS on
that port; turn TLS off, or use the server's TLS port.

**Oracle over TLS.** Not supported yet — connect directly or through SSH.

**"The host key of … was not trusted".** DataNest checks SSH host keys as OpenSSH does.
The first time you are asked to trust a server's key. If a known server's key changes,
DataNest warns you loudly and connects only if you choose **Trust the New Key** — do that
only when you know why the key changed.

**Project connections do not appear.** They live in `.vscode/datanest.json` and are used
only in a trusted workspace. Trust it, or move the connection to your own list.

## MongoDB and Elasticsearch

**My MongoDB statement with a variable or a loop does not run.** DataNest reads the
statement as data — `db.coll.find({…})`, `aggregate([…])` and so on — and never runs it as
JavaScript. Write the values themselves: `ObjectId("…")`, `ISODate("…")`,
`NumberLong("…")`.

**Elasticsearch says the server is not Elasticsearch.** DataNest works with Elasticsearch
and OpenSearch; another server answering on that port is refused.

## Something went wrong

**Where is the log?** **Show Logs** opens the DataNest output channel. Set
`datanest.logLevel` to `debug` for every detail, repeat what failed, and attach the log to
an issue — passwords and tokens are masked, but read it through before sharing.

**How do I report a bug?** Run **DataNest: Report a Problem…** from the Command Palette
(or the "…" menu of the Connections view). It opens the bug form on
[GitHub](https://github.com/Muhammadali1620/DataNest/issues) with the DataNest, editor and
system versions filled in; add the database and its version, what you did, what you
expected and the log. Nothing about your connections is sent — only what you write.
