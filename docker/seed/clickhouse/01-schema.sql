-- Test data for ClickHouse (V6.3). Runs once on container start (as the datanest user).
-- Mirrors docker/seed/postgres with the same rows, plus ClickHouse types and engines.
-- Integration tests rely on these exact rows: change them together with test/integration.

CREATE DATABASE IF NOT EXISTS datanest_test;
CREATE DATABASE IF NOT EXISTS datanest_empty;

CREATE TABLE datanest_test.customers (
  id UInt32,
  email String,
  full_name Nullable(String),
  country Nullable(FixedString(2)),
  created_at DateTime DEFAULT '2024-01-01 00:00:00'
) ENGINE = MergeTree ORDER BY id COMMENT 'Shop customers';

CREATE TABLE datanest_test.products (
  id UInt32,
  sku String,
  name String COMMENT 'What the shop calls it',
  price Decimal(10, 2),
  stock Int32 DEFAULT 0,
  is_active Bool DEFAULT true,
  attributes Nullable(String),
  INDEX ix_products_name name TYPE bloom_filter GRANULARITY 4
) ENGINE = MergeTree ORDER BY id;

CREATE TABLE datanest_test.orders (
  id UInt32,
  customer_id UInt32,
  status Enum8('new' = 1, 'paid' = 2, 'shipped' = 3, 'cancelled' = 4) DEFAULT 'new',
  ordered_at DateTime,
  note Nullable(String)
) ENGINE = MergeTree ORDER BY (customer_id, id);

CREATE TABLE datanest_test.order_items (
  order_id UInt32,
  product_id UInt32,
  quantity Int32,
  unit_price Decimal(10, 2),
  line_total Decimal(12, 2) MATERIALIZED quantity * unit_price
) ENGINE = MergeTree ORDER BY (order_id, product_id);

-- One fully filled row and one row of NULLs and defaults for value normalization tests.
CREATE TABLE datanest_test.all_types (
  id UInt32,
  c_int8 Nullable(Int8),
  c_uint8 Nullable(UInt8),
  c_int32 Nullable(Int32),
  c_int64 Nullable(Int64),
  c_uint64 Nullable(UInt64),
  c_int128 Nullable(Int128),
  c_float32 Nullable(Float32),
  c_float64 Nullable(Float64),
  c_decimal Nullable(Decimal(38, 10)),
  c_bool Nullable(Bool),
  c_string Nullable(String),
  c_fixed Nullable(FixedString(3)),
  c_low LowCardinality(String),
  c_date Nullable(Date),
  c_date32 Nullable(Date32),
  c_datetime Nullable(DateTime('UTC')),
  c_datetime64 Nullable(DateTime64(6, 'UTC')),
  c_uuid Nullable(UUID),
  c_ipv4 Nullable(IPv4),
  c_enum Nullable(Enum8('a' = 1, 'b' = 2)),
  c_array Array(Int32),
  c_map Map(String, Int32),
  c_tuple Tuple(String, Int32),
  c_nan Nullable(Float64)
) ENGINE = MergeTree ORDER BY id;

-- 10 000 rows for pagination and streaming tests.
CREATE TABLE datanest_test.big_table (
  id UInt32,
  label String,
  value_mod UInt32
) ENGINE = MergeTree ORDER BY id;

INSERT INTO datanest_test.customers (id, email, full_name, country, created_at) VALUES
  (1, 'alice@example.com', 'Alice Johnson', 'US', '2024-01-02 08:00:00'),
  (2, 'bob@example.com', 'Bob O\'Brien', 'IE', '2024-01-03 09:30:00'),
  (3, 'olga@example.com', 'Ольга Иванова', 'RU', '2024-02-10 12:00:00'),
  (4, 'hiro@example.com', '山田 博', 'JP', '2024-03-05 15:45:00'),
  (5, 'noname@example.com', NULL, NULL, '2024-04-01 00:00:00');

INSERT INTO datanest_test.products (id, sku, name, price, stock, is_active, attributes) VALUES
  (1, 'SKU-001', 'Keyboard', 49.99, 120, true, '{"color": "black", "layout": "US"}'),
  (2, 'SKU-002', 'Mouse', 19.50, 300, true, '{"dpi": 1600}'),
  (3, 'SKU-003', 'Monitor 27"', 329.00, 15, true, '{"size": 27, "panel": "IPS"}'),
  (4, 'SKU-004', 'USB-C Cable', 9.99, 0, false, NULL),
  (5, 'SKU-005', 'Rocket Mug 🚀', 12.00, 42, true, '{"emoji": "🚀"}'),
  (6, 'SKU-006', 'Desk Lamp', 35.25, 7, true, '{}');

INSERT INTO datanest_test.orders (id, customer_id, status, ordered_at, note) VALUES
  (1, 1, 'paid', '2024-01-15 10:00:00', NULL),
  (2, 1, 'shipped', '2024-02-01 12:30:00', 'Leave at the door'),
  (3, 2, 'new', '2024-03-10 09:15:00', NULL),
  (4, 3, 'paid', '2024-03-11 18:45:00', 'Позвонить заранее'),
  (5, 3, 'cancelled', '2024-04-02 08:00:00', NULL),
  (6, 4, 'shipped', '2024-05-20 23:59:59', NULL),
  (7, 2, 'paid', '2024-06-01 00:00:00', NULL),
  (8, 5, 'new', '2024-06-15 14:00:00', NULL);

INSERT INTO datanest_test.order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 49.99), (1, 2, 2, 19.50),
  (2, 3, 1, 329.00),
  (3, 5, 4, 12.00),
  (4, 1, 1, 49.99), (4, 6, 2, 35.25),
  (5, 4, 3, 9.99),
  (6, 3, 2, 329.00), (6, 2, 1, 19.50),
  (7, 5, 1, 12.00),
  (8, 6, 1, 35.25), (8, 2, 3, 19.50);

INSERT INTO datanest_test.all_types VALUES (
  1, -128, 255, 2147483647, 9223372036854775807, 18446744073709551615,
  -170141183460469231731687303715884105728, 1.5, 3.141592653589793,
  12345678901234567890.0123456789, true, 'O\'Brien "quoted" \\ backslash\nline two', 'abc',
  'low', '2024-02-29', '1900-01-01', '2024-12-31 23:59:59', '2024-12-31 23:59:59.123456',
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', '192.168.0.1', 'b', [1, 2, 3],
  {'one': 1, 'two': 2}, ('x', 7), nan
);
INSERT INTO datanest_test.all_types (id) VALUES (2);

INSERT INTO datanest_test.big_table SELECT number + 1, concat('row-', leftPad(toString(number + 1), 5, '0')), (number + 1) % 100 FROM numbers(10000);

CREATE VIEW datanest_test.order_totals AS
SELECT o.id AS order_id, o.customer_id, o.status, sum(i.quantity * i.unit_price) AS total
FROM datanest_test.orders AS o
INNER JOIN datanest_test.order_items AS i ON i.order_id = o.id
GROUP BY o.id, o.customer_id, o.status;

CREATE MATERIALIZED VIEW datanest_test.product_sales
ENGINE = SummingMergeTree ORDER BY product_id POPULATE AS
SELECT product_id, sum(quantity) AS units_sold FROM datanest_test.order_items GROUP BY product_id;
