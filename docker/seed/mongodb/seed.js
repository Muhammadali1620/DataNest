// Test data for the MongoDB integration tests (V7.5): databases, collections of every
// kind, indexes of every kind and documents with every BSON type. Loaded by
// docker/mongodb/start.sh with mongosh once the replica set has a primary.

const admin = db.getSiblingDB('admin');
admin.createUser({
  user: 'reader',
  pwd: 'reader',
  roles: [{ role: 'readAnyDatabase', db: 'admin' }],
});
// X.509: the subject of docker/tls/client.crt.
db.getSiblingDB('$external').createUser({
  user: 'CN=datanest_cert',
  roles: [{ role: 'readAnyDatabase', db: 'admin' }],
});

const shop = db.getSiblingDB('shop');

shop.customers.insertMany([
  { _id: 1, name: 'Ada', email: 'ada@example.com', city: 'London', tags: ['vip'] },
  { _id: 2, name: 'Linus', email: 'linus@example.com', city: 'Helsinki', tags: [] },
  { _id: 3, name: 'Grace', email: 'grace@example.com', city: 'New York' },
]);
shop.customers.createIndex({ email: 1 }, { unique: true, name: 'email_unique' });
shop.customers.createIndex({ city: 1, name: -1 });
shop.customers.createIndex({ name: 'text' });

const orders = [];
for (let i = 1; i <= 250; i += 1) {
  orders.push({
    _id: i,
    customer: (i % 3) + 1,
    total: NumberDecimal(`${i}.50`),
    items: i % 5,
    status: i % 4 === 0 ? 'shipped' : 'new',
    createdAt: new Date(Date.UTC(2026, 0, 1) + i * 3600 * 1000),
  });
}
shop.orders.insertMany(orders);
shop.orders.createIndex({ customer: 1, createdAt: -1 });
shop.orders.createIndex({ createdAt: 1 }, { expireAfterSeconds: 315360000, name: 'createdAt_ttl' });
shop.orders.createIndex(
  { status: 1 },
  { partialFilterExpression: { status: 'shipped' }, name: 'shipped_only' },
);
shop.orders.createIndex({ customer: 'hashed' });

shop.createView('big_orders', 'orders', [{ $match: { items: { $gte: 4 } } }]);
shop.createCollection('events', { capped: true, size: 1048576, max: 1000 });
shop.events.insertOne({ kind: 'started' });
shop.createCollection('metrics', { timeseries: { timeField: 'at', metaField: 'sensor' } });
shop.metrics.insertOne({ at: new Date(Date.UTC(2026, 0, 1)), sensor: 'a', value: 1.5 });
shop.createCollection('places');
shop.places.insertOne({ name: 'Office', location: { type: 'Point', coordinates: [13.4, 52.5] } });
shop.places.createIndex({ location: '2dsphere' });
shop.createCollection('validated', {
  validator: { $jsonSchema: { bsonType: 'object', required: ['name'] } },
});

// Every BSON type, in a fixed order, with the edge values.
const types = db.getSiblingDB('types');
types.values.insertOne({
  _id: ObjectId('65a1b2c3d4e5f60718293a4b'),
  double: 1.5,
  doubleWhole: Double(2),
  doubleNegZero: -0.0,
  nan: NaN,
  inf: Infinity,
  int32: NumberInt(42),
  int64: NumberLong('9223372036854775807'),
  decimal: NumberDecimal('1234567890.123456789012345678'),
  string: 'héllo "world"\n\t✓',
  emptyString: '',
  bool: true,
  nullValue: null,
  date: ISODate('2026-10-29T12:34:56.789Z'),
  dateOld: new Date(-62198755200000),
  binary: BinData(0, 'AAEC/w=='),
  uuid: UUID('3b241101-e2bb-4255-8caf-4136c566a962'),
  regex: /ab\/c+/i,
  timestamp: Timestamp({ t: 1700000000, i: 7 }),
  minKey: MinKey(),
  maxKey: MaxKey(),
  code: Code('function () { return 1; }'),
  array: [1, 'two', [3], { four: 4 }],
  nested: { a: { b: { c: 'deep' } } },
  12: 'numeric key',
  'dotted.name': 'with a dot',
  $dollar: 'leading dollar',
});
types.big.insertOne({ _id: 'big', text: 'x'.repeat(2 * 1024 * 1024) });

const empty = db.getSiblingDB('emptydb');
empty.createCollection('nothing');

db.getSiblingDB('datanest').seed.insertOne({ _id: 'done' });
