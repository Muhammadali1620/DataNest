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
- A **RedisJSON** key (type `ReJSON-RL`, from Redis Stack) opens as a tree of its document,
  one level at a time, so a huge document is never read whole: objects and arrays show
  their size, scalars their value, in the colour of their kind. Select a node to see its
  text and its JSONPath, copy either, edit the value of the node (the text must be valid
  JSON; numbers are kept as written) or delete a member. Only an existing path is
  replaced, so nothing is created by mistake; a read-only connection offers no change and a
  production one asks first. A part bigger than 4 MB in memory is not shown whole. Without
  the module on the server the page says so, and TTL, rename and delete still work.
- **New Key…**, **Rename Key…**, **Delete Key**.
- **Export Keys…** writes the keys of a database, of a folder or of the selected keys to a
  file, one JSON record per line (strings, hashes, lists, sets, sorted sets and streams,
  with their TTLs; bytes that are not text as base64). It walks with `SCAN` and cuts big
  collections into records, so memory stays small, and it can be cancelled. **Restore
  Keys…** reads such a file back and asks what to do with a key that exists: skip it,
  overwrite it, or restore everything under a prefix. A read-only connection refuses it,
  and a production one asks first.
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
- **Export Index…** on an index writes its documents to a file, one per line: with the
  mappings and settings in a header line (so a new index can be made just like it), as
  documents only, or in the `_bulk` format for `curl`. It reads the index with a scroll, a
  page at a time, so a big index does not sit in memory, and 64-bit numbers stay exact.
  **Import Documents…** loads such a file (or any NDJSON or JSON array of documents) into an
  index through `_bulk`: keep the ids and replace what exists, keep the ids and leave what
  exists, or make up new ids; a refused document either stops the load or is skipped, and
  the report lists its line. **Import as New Index…** on the connection makes the index from
  the header of the file first. Loading follows the production and read-only rules.
