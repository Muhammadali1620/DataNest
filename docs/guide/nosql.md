# Redis, MongoDB, Elasticsearch, etcd and ZooKeeper

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

## etcd

DataNest talks to etcd v3 through the cluster's HTTP/JSON gateway on the client port
(2379), so there is nothing to install; TLS, SSH tunnels and proxies work as for the other
connections. Give a user and password when the cluster has authentication (the sign-in
token is renewed by itself); leave both empty when it has none.

- **Keys** appear as folders made by splitting the names at `/`. A folder is read when you
  open it, a page at a time (`datanest.etcd.keysPerLoad`), by a range over its prefix, so
  nothing below it is read ahead and a huge store opens as fast as a small one; the number
  next to a folder is the cluster's own count of the keys below it. **Load More Keys**
  brings the next page. A key that dies with a lease has a clock icon.
- **Find etcd Key by Prefix…** lists the keys that start with what you type (etcd has no
  "contains", only ranges) and opens the one you pick.
- **Open etcd Key** shows a key on a page of its own: the value as text, JSON or hex, the
  revision of its last change, its version, its size and its lease with the time left.
  **Save** is a compare-and-swap on the revision the page read: when somebody changed the
  key meanwhile, nothing is overwritten; the page says so, keeps your text and offers
  to load the server's value or to overwrite it on purpose. The lease the key has is kept
  when you save.
- **Leases**: attach a new lease of N seconds, attach an existing one by its id (a decimal
  number, as the gateway writes it), detach it so the key stays for good, or revoke it
  (which deletes every key attached to it, after a question).
- **New etcd Key…** makes a key with an empty value and opens its page; a name that is
  taken is refused. **Delete etcd Keys** deletes the clicked key, the selected keys or
  everything under a folder, after saying how many keys that is.
- A read-only connection offers no change, and a production one asks before every one.
  Keys whose names are not text are shown with `\xHH` for the bytes and found again byte
  for byte.

- **Watch** (a button on the key page) follows the key as the cluster changes it: every put
  and delete is listed with the time, the revision and the start of the new value, and the
  value above follows it. Tick **and the keys below** to watch every key that starts with
  this name as well. What you are typing is never replaced: the page warns that the key
  moved on, and saving then asks, as it always does. A watch ends when you press the
  button, close the page, or the cluster or the link ends it; the list stays.
- **etcd Users and Roles…** lists the users and roles, grants roles and permissions, and
  also turns **authentication on and off** (etcd then wants a user named `root` with the
  role `root`; once it is on, every connection has to sign in, which the question says).

Not here (yet): etcd's cluster administration (members, snapshots) and watching a prefix
from the tree.

## Apache ZooKeeper

DataNest speaks ZooKeeper's own client protocol, in a small client of its own (no library is
installed); TLS (the secure client port), SSH tunnels and proxies work as for the other
connections. The host box takes one server or a list separated by commas (`a:2181,b:2181`;
the first that answers is used). Give a user and password to sign in with the `digest`
scheme (znodes that are created then get the creator's ACL); leave both empty when the
znodes are open to everyone. **Chroot** makes a znode such as `/app` the root of the tree.

- **Znodes** form a tree, and every znode holds data and may have children besides. A znode
  is read when you open it, a page at a time (`datanest.zookeeper.childrenPerLoad`);
  **Load More Znodes** brings the next page. The number next to a znode is how many children
  it has. Colour tells what a znode is: a clock for an ephemeral one (it ends with its
  session), a box for a container, a list for a sequential one (its name ends in a counter).
- **Go to ZooKeeper Znode…** opens a znode by its whole path (ZooKeeper cannot search).
- **Open ZooKeeper Znode** shows a znode on a page of its own: the data as text, JSON or
  hex, its stat (the transaction ids as `0x…`, times, versions, the owner session of an
  ephemeral node), its ACL as `world:anyone rwcda`, and its children, which open on a click.
  **Save** is a compare-and-set on the version the page read: when somebody changed the
  znode meanwhile, nothing is overwritten; the page says so, keeps your text and offers to
  load the server's data or to overwrite it on purpose. A znode whose ACL does not allow you
  to read its data says so instead of showing it.
- **New ZooKeeper Znode…** makes a child with empty data (persistent, sequential or
  container) and opens its page; a name that is taken is refused.
  **Delete ZooKeeper Znodes** deletes the clicked znode or the selected ones with everything
  below them, after saying how many znodes that is.
- A read-only connection offers no change, and a production one asks before every one.

- **Watch** (a button on the znode page) lists every change of the znode as it happens:
  its data, its children, its creation and its deletion, each with how the znode looks
  just after it. The page reads the znode again at every change, and never replaces what
  you are typing. It ends when you press the button, close the page, or the session ends.
- In the ACL editor, **Give the same ACL to the znodes below, too** replaces the ACL of
  every znode under this one, after a question that says how many. A znode you may not
  change is skipped and named in the report.

Not here (yet): ephemeral znodes (they would end with DataNest's own session), and the
server's four-letter commands.

## Apache Kafka

DataNest browses a Kafka cluster with the pure-JavaScript client `kafkajs`; nothing native
is installed. Give the **bootstrap brokers** in the Host box as `host:port` separated by
commas (a broker without a port takes the one in the Port box, 9092 by default). Choose
how the brokers want you to sign in (**None**, **PLAIN**, **SCRAM-SHA-256** or
**SCRAM-SHA-512**, with the user and password of the connection) and turn TLS on below
when the listener is encrypted.

- The tree shows **Topics** (the cluster's own, such as `__consumer_offsets`, only with
  `datanest.kafka.showInternalTopics`) and **Consumer groups**. A topic opens into its
  partitions, each with the offsets it holds; a group opens into the lag it has per
  partition, `orders [0]: 12 behind`. **New Kafka Topic…** asks for the name, the number
  of partitions and of copies; **Delete Kafka Topic** asks first.
- **Open Kafka Topic** (a click on a topic or a partition) opens its page: the partitions
  with a bar for how full each is, the leader and how many replicas are in sync. Read the
  **last** messages of a partition, messages **from an offset** or **from a time**
  (up to 500 at a time). Pick a message to see its key and value as text, JSON or hex, its
  headers and its time. Offsets are 64-bit numbers and stay exact.
- **Send a message** takes a key, a value (text, JSON or hex), headers (`name: value`
  lines), and a partition, or lets the cluster choose. A **tombstone** is a message
  without a value, which marks the key as deleted for a compacted topic.
- **Reading never moves anything.** The client can read only through a consumer group, so
  each read uses a group of its own with a throw-away name (`datanest-peek-…`), turns
  auto-commit off and never commits: none of your groups is joined and none of their
  offsets changes. The throw-away group is empty and without offsets afterwards, so the
  broker forgets it, and the group list hides the name. A read waits for the group to
  join, so on a real broker it takes a few seconds (the broker's
  `group.initial.rebalance.delay.ms`).
- A read-only connection offers no change, and a production one asks before sending a
  message or creating a topic.
- Connections through an SSH tunnel or a proxy reach only the bootstrap address; a broker
  then advertises its own address, which the tunnel does not cover. Use brokers that
  advertise addresses you can reach.

Not here (yet): a live view of new messages, Avro/Protobuf decoding through a schema
registry, committing offsets for a group, ACLs and the cluster's configuration.

## RabbitMQ

DataNest browses a RabbitMQ broker through the HTTP API of its **management plugin**, so
nothing native and no AMQP client is needed. Give the broker's address in the Host box and
the plugin's port (15672 by default, **not** the AMQP port 5672) in the Port box, and sign
in with a user that has the `management` tag; an empty user is `guest`, which a broker
accepts only from its own machine. The **Virtual host** box is optional: filled in, the
tree shows only that virtual host, which is what a user who may see just one needs.

- The tree shows the **virtual hosts**, each with its **Queues** and **Exchanges**. A queue
  is coloured green while it is empty, orange while messages wait and red when it is down,
  and says how many are ready, unacknowledged and how many consumers it has; an exchange
  has an icon and a colour for its type. A folder lists the first 500 and counts the rest.
  **New Queue…** (classic, quorum or stream) and **New Exchange…** ask for a name and a
  type; **Remove All Messages** and **Delete** ask first.
- **Open Queue or Exchange** (a click) opens its page: the four figures of a queue as
  coloured cards with a bar for ready against unacknowledged, its properties (type, state,
  memory, policy, node), its arguments, and its **bindings**. Every queue is also bound to
  the default exchange under its own name, as the broker has it.
- On a queue's page, **Consumers** lists who reads the queue (tag, connection, user, prefetch,
  whether it acknowledges). **Add a binding** binds a queue to an exchange; an exchange can be
  bound to a queue or to another exchange, and another exchange can be bound into it, each with a
  routing key and arguments (a JSON object). **Remove the binding** asks first. The binding every
  queue has to the default exchange is the broker's and cannot be removed; the default exchange
  cannot be bound.
- **Administration** (the last item of a virtual host, with a shield) opens the page of the virtual
  host: its **connections** (client, user, address, state, channels, since when, traffic; close one
  after a question), its **users and permissions** (tags, and the three patterns of names each user
  may configure, write to and read from here; set or take away access; create or delete a user,
  never the one DataNest signs in as) and its **policies** (create, edit, delete). Users and
  permissions need the `administrator` tag; without it that part says so and the others still show.
  The broker refreshes its list of connections every few seconds, so a connection just opened
  may take that long to appear. The pencil of a user changes its **password** (empty keeps the
  old one) or its **tags**; changing only the tags keeps the password.
- **New Virtual Host…** (on a connection or a virtual host) makes one, and **Delete Virtual Host**
  removes it with every queue, exchange, binding and message in it after a question. A connection
  that is limited to one virtual host cannot make others.
- **Live graphs** on a queue's page: **Start** reads the queue every few seconds and draws two
  graphs, the ready and unacknowledged messages and the rates per second of publishing,
  delivery and acknowledgement. The rates are the broker's own, which it refreshes about every
  5 seconds, so they move in steps. **Stop** keeps what was read until the next start; closing
  the page stops it.
- **Look at the first messages** shows up to 100 messages of a queue with their payload (text,
  JSON or hex), routing key, size and properties. **Nothing is taken from the queue:** each
  message is fetched with `ack_requeue_true`, which puts it back at once. The broker marks
  a message it has handed out before as redelivered, so the next look shows the flag, and a
  message put back may change its place among the others. A payload is cut at 256 KB; its
  real length stays visible.
- **Publish a message** sends one through the default exchange to the queue, or through
  an exchange with a routing key; give a payload (text, JSON or hex), a content type,
  persistence and headers. You are told when no queue took the message.
- A read-only connection offers no change, and a production one asks before publishing or
  creating anything.
- Every request opens a connection of its own: the plugin closes idle connections at
  moments of its own, and one sent down a connection it has just closed would fail, even
  a publish that must not be sent twice.

Not here (yet): creating and removing bindings, consumers and connections of the broker,
users, permissions and policies, and a live view of the rates.
