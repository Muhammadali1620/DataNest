# Redis, MongoDB and Elasticsearch

These connections live in the same tree, with the same folders, SSH, TLS, production and
read-only marks, but each speaks its own language and has pages of its own. SQL commands
do not apply to them, and theirs do not apply to SQL connections.

## Redis

- **Keys** appear under each database, split into folders by `:`
  (`datanest.redis.keySeparator`). They are read with `SCAN`, a portion at a time
  (`datanest.redis.keysPerLoad`), so a big server is never blocked; **Load More Keys**
  brings the next portion. **Filter Keys…** narrows them with a pattern such as `user:*`;
  **Find Redis Key…** jumps to one by name.
- **Open Key** shows a key on a page of its own: a string as text, JSON or hex; hashes,
  lists, sets, sorted sets and streams as tables you can edit. The TTL can be set or
  removed. Values are bytes: nothing is changed on the way.
- **New Key…**, **Rename Key…**, **Delete Key**.
- **Open Redis Console** runs commands as `redis-cli` would, with suggestions taken from
  the server's own command documentation. Commands that would turn the console into a
  stream (`SUBSCRIBE`, `MONITOR`) are refused, as are those that would change the
  connection itself (`AUTH`, `HELLO`). On a read-only connection anything that may write is
  refused; safe mode asks before `FLUSHALL`, `CONFIG SET` and `KEYS`.
- **Redis Server Info** shows the server's `INFO`, grouped.

## MongoDB

- Databases, collections, views and their indexes appear in the tree; **New Database…**,
  **New Collection…**, **Rename Collection…**, **New Index…** and the matching drops are on
  them.
- **Open Documents** shows a collection with a filter, a sort and a projection, as a table
  or as text. Editing a document replaces it only if nobody changed it since you read it.
- **New MongoDB Query** opens an editor for statements in the `mongosh` style:
  `db.orders.find({ status: "new" }).sort({ created: -1 })`, `aggregate`, the counts,
  inserts, updates, deletes, index commands and `db.runCommand`. `Ctrl+Enter` runs the
  statement under the cursor. DataNest reads these statements itself — it never runs them
  as JavaScript — so values are written as data: `ObjectId("…")`, `ISODate("…")`,
  `NumberLong("…")`, `NumberDecimal("…")`.
- Exact BSON types and the order of fields are kept when documents are shown, edited and
  copied.
- **Export Documents…** on a collection writes it to a file, one document per line in
  canonical Extended JSON, so every type comes back as it was. **Import Documents…** reads
  such a file — or one written by `mongoexport`, relaxed or as a JSON array — and inserts in
  batches; a refused document (a duplicate `_id`, a broken line) either stops the import
  or is skipped, and the report lists its line.

## Elasticsearch and OpenSearch

- Indices and the fields of their mappings appear in the tree; **New Index…** (with
  settings and mappings as JSON) and **Delete Index…**.
- **New Elasticsearch Query** opens an editor for requests written as in a console:

  ```
  GET /products/_search
  { "query": { "match": { "name": "lamp" } } }
  ```

  `Ctrl+Enter` sends the request under the cursor. A query opened from an index starts with
  templates of the usual requests: search, count, a grouping, adding and changing a
  document, how a text is split into words, the mapping and the settings.
- **Copy as cURL** (editor context menu) copies the request under the cursor as a `curl`
  command for a POSIX shell — without secrets: curl asks for the password, an API key is
  read from `ELASTIC_API_KEY`. **Show Settings** on an index opens its settings as JSON. Hits are shown as a table, and the
  whole answer as text; 64-bit numbers stay exact. `_bulk` and `_msearch` take NDJSON
  bodies. Requests that change or delete data follow the connection's production,
  read-only and safe mode rules.
