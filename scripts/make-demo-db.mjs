// @ts-check
// Builds a small shop database (SQLite) for the screenshots of the README:
//   node scripts/make-demo-db.mjs <output.db>
// Fixed seed, so every run gives the same file.
import { DatabaseSync } from 'node:sqlite';
import { rmSync } from 'node:fs';

const out = process.argv[2];
if (!out) {
  console.error('usage: node scripts/make-demo-db.mjs <output.db>');
  process.exit(1);
}
rmSync(out, { force: true });
const db = new DatabaseSync(out);

let seed = 20261031;
const rnd = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
/**
 * @template T
 * @param {T[]} list
 * @returns {T}
 */
function pick(list) {
  const item = list[Math.floor(rnd() * list.length)];
  if (item === undefined) {
    throw new Error('empty list');
  }
  return item;
}
/**
 * @param {number} a
 * @param {number} b
 */
const between = (a, b) => a + Math.floor(rnd() * (b - a + 1));

db.exec(`
PRAGMA foreign_keys = ON;
CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  parent_id INTEGER REFERENCES categories(id)
);
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  city TEXT,
  vip INTEGER NOT NULL DEFAULT 0 CHECK (vip IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  sku TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  price REAL NOT NULL CHECK (price > 0),
  stock INTEGER NOT NULL DEFAULT 0,
  attributes TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'paid', 'shipped', 'delivered', 'cancelled')),
  total REAL NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_price REAL NOT NULL
);
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body TEXT
);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_status_created ON orders(status, created_at);
CREATE INDEX idx_items_order ON order_items(order_id);
CREATE INDEX idx_products_category ON products(category_id);
CREATE TRIGGER trg_items_total AFTER INSERT ON order_items
BEGIN
  UPDATE orders SET total = ROUND(total + NEW.quantity * NEW.unit_price, 2) WHERE id = NEW.order_id;
END;
CREATE VIEW v_sales_by_category AS
  SELECT c.name AS category, COUNT(DISTINCT o.id) AS orders, ROUND(SUM(i.quantity * i.unit_price), 2) AS revenue
  FROM order_items i
  JOIN products p ON p.id = i.product_id
  JOIN categories c ON c.id = p.category_id
  JOIN orders o ON o.id = i.order_id
  GROUP BY c.name;
`);

const categories = [
  'Laptops',
  'Phones',
  'Audio',
  'Cameras',
  'Gaming',
  'Home',
  'Office',
  'Accessories',
];
const insCat = db.prepare('INSERT INTO categories (name) VALUES (?)');
categories.forEach((c) => insCat.run(c));

const first = [
  'Alice',
  'Bruno',
  'Chen',
  'Dilnoza',
  'Elena',
  'Farid',
  'Grace',
  'Hiro',
  'Ivan',
  'Julia',
  'Karim',
  'Lucia',
  'Marco',
  'Nora',
  'Omar',
  'Petra',
  'Quinn',
  'Rosa',
  'Sven',
  'Timur',
  'Uma',
  'Victor',
  'Wen',
  'Yusuf',
  'Zoe',
];
const last = [
  'Smith',
  'Rossi',
  'Wang',
  'Karimov',
  'Petrova',
  'Aliyev',
  'Miller',
  'Tanaka',
  'Ivanov',
  'Silva',
  'Haddad',
  'Garcia',
  'Novak',
  'Schmidt',
  'Dubois',
  'Kim',
  'Lopez',
  'Nilsen',
  'Yilmaz',
  'Brown',
];
const places = [
  ['Germany', 'Berlin'],
  ['Uzbekistan', 'Tashkent'],
  ['Spain', 'Madrid'],
  ['Japan', 'Osaka'],
  ['Brazil', 'Recife'],
  ['Turkey', 'Izmir'],
  ['France', 'Lyon'],
  ['China', 'Shenzhen'],
  ['Italy', 'Turin'],
  ['USA', 'Austin'],
];
const insCust = db.prepare(
  'INSERT INTO customers (first_name, last_name, email, country, city, vip, created_at) VALUES (?,?,?,?,?,?,?)',
);
/** @param {number} n */
const day = (n) =>
  new Date(Date.UTC(2026, 0, 1) + n * 86400000 + between(0, 80000) * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
for (let i = 1; i <= 240; i++) {
  const f = pick(first);
  const l = pick(last);
  const [country = '', city = ''] = pick(places);
  insCust.run(
    f,
    l,
    `${f}.${l}.${i}@example.com`.toLowerCase(),
    country,
    rnd() < 0.1 ? null : city,
    rnd() < 0.12 ? 1 : 0,
    day(between(0, 200)),
  );
}

/** @type {Record<string, string[]>} */
const things = {
  Laptops: ['Aero 14', 'Pro 16', 'Slim 13', 'Studio 15'],
  Phones: ['Nova 5', 'Pulse X', 'Edge 12', 'Mini S'],
  Audio: ['Studio Buds', 'Bass Pro', 'Air Pods', 'Soundbar 5'],
  Cameras: ['Lens Pro', 'Pocket 4K', 'Action Cam'],
  Gaming: ['Pad Elite', 'Arena Mouse', 'Keyboard K9'],
  Home: ['Smart Lamp', 'Robo Vac', 'Air Clean'],
  Office: ['Desk Pro', 'Chair Flex', 'Monitor 27'],
  Accessories: ['Cable USB-C', 'Charger 65W', 'Case Slim'],
};
const insProd = db.prepare(
  'INSERT INTO products (category_id, sku, name, price, stock, attributes, active) VALUES (?,?,?,?,?,?,?)',
);
let sku = 1000;
categories.forEach((c, idx) => {
  for (const base of things[c] ?? []) {
    for (const v of ['', ' Max', ' Lite']) {
      sku += 1;
      const price = Math.round((between(15, 1900) + rnd()) * 100) / 100;
      insProd.run(
        idx + 1,
        `SKU-${sku}`,
        base + v,
        price,
        between(0, 250),
        JSON.stringify({
          color: pick(['black', 'silver', 'blue', 'white']),
          warranty_months: pick([12, 24, 36]),
        }),
        rnd() < 0.95 ? 1 : 0,
      );
    }
  }
});
const products = /** @type {{ id: number; price: number }[]} */ (
  /** @type {unknown} */ (db.prepare('SELECT id, price FROM products').all())
);

const statuses = [
  'new',
  'paid',
  'paid',
  'shipped',
  'shipped',
  'delivered',
  'delivered',
  'delivered',
  'cancelled',
];
const insOrder = db.prepare(
  'INSERT INTO orders (customer_id, status, note, created_at) VALUES (?,?,?,?)',
);
const insItem = db.prepare(
  'INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES (?,?,?,?)',
);
for (let i = 1; i <= 900; i++) {
  const o = insOrder.run(
    between(1, 240),
    pick(statuses),
    rnd() < 0.15 ? 'Leave at the door' : null,
    day(between(0, 300)),
  );
  for (let k = between(1, 4); k > 0; k--) {
    const p = pick(products);
    insItem.run(Number(o.lastInsertRowid), p.id, between(1, 3), p.price);
  }
}
const insRev = db.prepare(
  'INSERT INTO reviews (product_id, customer_id, rating, body) VALUES (?,?,?,?)',
);
const bodies = [
  'Works great',
  'Battery could be better',
  'Fast delivery',
  'Worth the price',
  'Not what I expected',
  null,
];
for (let i = 0; i < 300; i++)
  insRev.run(pick(products).id, between(1, 240), between(1, 5), pick(bodies));
db.exec('ANALYZE');
db.close();
console.log('written', out);
