-- Test data for PostgreSQL. Runs once on container start (as the datanest superuser).
-- Mirrors docker/seed/mysql with the same rows, plus PostgreSQL-only objects.
-- Integration tests rely on these exact rows: change them together with test/integration.
\set ON_ERROR_STOP on
SET client_encoding = 'UTF8';
SET TIME ZONE 'UTC';

CREATE TYPE order_status AS ENUM ('new', 'paid', 'shipped', 'cancelled');

CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  full_name VARCHAR(255),
  country CHAR(2),
  created_at TIMESTAMP NOT NULL DEFAULT '2024-01-01 00:00:00'
);
COMMENT ON TABLE customers IS 'Shop customers';

CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(255) NOT NULL,
  price NUMERIC(10, 2) NOT NULL CHECK (price >= 0),
  stock INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  attributes JSONB
);
CREATE INDEX ix_products_name ON products (name);

CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers (id),
  status order_status NOT NULL DEFAULT 'new',
  ordered_at TIMESTAMP NOT NULL,
  note TEXT
);
CREATE INDEX ix_orders_customer ON orders (customer_id);

CREATE TABLE order_items (
  order_id INTEGER NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products (id),
  quantity INTEGER NOT NULL,
  unit_price NUMERIC(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

-- One fully filled row and one row of NULLs for value normalization tests.
CREATE TABLE all_types (
  id INTEGER PRIMARY KEY,
  c_smallint SMALLINT,
  c_int INTEGER,
  c_bigint BIGINT,
  c_numeric NUMERIC(30, 10),
  c_real REAL,
  c_double DOUBLE PRECISION,
  c_bool BOOLEAN,
  c_char CHAR(3),
  c_varchar VARCHAR(255),
  c_text TEXT,
  c_date DATE,
  c_time TIME,
  c_timetz TIMETZ,
  c_timestamp TIMESTAMP(6),
  c_timestamptz TIMESTAMPTZ,
  c_interval INTERVAL,
  c_uuid UUID,
  c_json JSON,
  c_jsonb JSONB,
  c_bytea BYTEA,
  c_int_array INTEGER[],
  c_text_array TEXT[],
  c_inet INET,
  c_status order_status
);

-- 10 000 rows for pagination and streaming tests.
CREATE TABLE big_table (
  id INTEGER PRIMARY KEY,
  label VARCHAR(32) NOT NULL,
  value_mod INTEGER NOT NULL
);
CREATE INDEX ix_big_value_mod ON big_table (value_mod);

INSERT INTO customers (id, email, full_name, country, created_at) VALUES
  (1, 'alice@example.com', 'Alice Johnson', 'US', '2024-01-02 08:00:00'),
  (2, 'bob@example.com', 'Bob O''Brien', 'IE', '2024-01-03 09:30:00'),
  (3, 'olga@example.com', 'Ольга Иванова', 'RU', '2024-02-10 12:00:00'),
  (4, 'hiro@example.com', '山田 博', 'JP', '2024-03-05 15:45:00'),
  (5, 'noname@example.com', NULL, NULL, '2024-04-01 00:00:00');
SELECT setval('customers_id_seq', 5);

INSERT INTO products (id, sku, name, price, stock, is_active, attributes) VALUES
  (1, 'SKU-001', 'Keyboard', 49.99, 120, TRUE, '{"color": "black", "layout": "US"}'),
  (2, 'SKU-002', 'Mouse', 19.50, 300, TRUE, '{"dpi": 1600}'),
  (3, 'SKU-003', 'Monitor 27"', 329.00, 15, TRUE, '{"size": 27, "panel": "IPS"}'),
  (4, 'SKU-004', 'USB-C Cable', 9.99, 0, FALSE, NULL),
  (5, 'SKU-005', 'Rocket Mug 🚀', 12.00, 42, TRUE, '{"emoji": "🚀"}'),
  (6, 'SKU-006', 'Desk Lamp', 35.25, 7, TRUE, '{}');
SELECT setval('products_id_seq', 6);

INSERT INTO orders (id, customer_id, status, ordered_at, note) VALUES
  (1, 1, 'paid', '2024-01-15 10:00:00', NULL),
  (2, 1, 'shipped', '2024-02-01 12:30:00', 'Leave at the door'),
  (3, 2, 'new', '2024-03-10 09:15:00', NULL),
  (4, 3, 'paid', '2024-03-11 18:45:00', 'Позвонить заранее'),
  (5, 3, 'cancelled', '2024-04-02 08:00:00', NULL),
  (6, 4, 'shipped', '2024-05-20 23:59:59', NULL),
  (7, 2, 'paid', '2024-06-01 00:00:00', NULL),
  (8, 5, 'new', '2024-06-15 14:00:00', NULL);
SELECT setval('orders_id_seq', 8);

INSERT INTO order_items (order_id, product_id, quantity, unit_price) VALUES
  (1, 1, 1, 49.99), (1, 2, 2, 19.50),
  (2, 3, 1, 329.00),
  (3, 5, 4, 12.00),
  (4, 1, 1, 49.99), (4, 6, 2, 35.25),
  (5, 4, 3, 9.99),
  (6, 3, 2, 329.00), (6, 2, 1, 19.50),
  (7, 5, 1, 12.00),
  (8, 6, 1, 35.25), (8, 2, 3, 19.50);

INSERT INTO all_types VALUES (
  1, 32767, 2147483647, 9223372036854775807, 12345678901234567890.0123456789,
  1.5, 3.141592653589793, TRUE, 'abc', E'O''Brien "quoted" \\ backslash',
  E'Многострочный\nтекст 🚀', '2024-02-29', '23:59:59', '23:59:59+03', '2024-12-31 23:59:59.123456',
  '2024-06-15 12:00:00+00', '1 year 2 mons 3 days 04:05:06', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  '{"nested": {"list": [1, 2, 3]}, "unicode": "日本語"}',
  '{"nested": {"list": [1, 2, 3]}, "unicode": "日本語"}',
  '\xdeadbeef', '{1,2,3}', '{"a","b c",NULL}', '192.168.0.1/24', 'paid'
);
INSERT INTO all_types (id) VALUES (2);

INSERT INTO big_table (id, label, value_mod)
SELECT n, 'row-' || LPAD(n::text, 5, '0'), n % 100
FROM generate_series(1, 10000) AS n;

CREATE VIEW order_totals AS
SELECT o.id AS order_id, o.customer_id, o.status, SUM(i.quantity * i.unit_price) AS total
FROM orders o
JOIN order_items i ON i.order_id = o.id
GROUP BY o.id, o.customer_id, o.status;

CREATE MATERIALIZED VIEW product_sales AS
SELECT p.id AS product_id, p.sku, SUM(i.quantity) AS units_sold
FROM products p
JOIN order_items i ON i.product_id = p.id
GROUP BY p.id, p.sku;

CREATE SEQUENCE invoice_number_seq START 1000;

CREATE FUNCTION order_total(p_order_id INTEGER) RETURNS NUMERIC(12, 2)
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(SUM(quantity * unit_price), 0)::NUMERIC(12, 2)
  FROM order_items WHERE order_id = p_order_id;
$$;

CREATE PROCEDURE restock(p_product_id INTEGER, p_amount INTEGER)
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE products SET stock = stock + p_amount WHERE id = p_product_id;
END;
$$;

CREATE FUNCTION order_items_quantity_check() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.quantity <= 0 THEN
    RAISE EXCEPTION 'quantity must be positive' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER order_items_quantity_check
BEFORE INSERT ON order_items
FOR EACH ROW EXECUTE FUNCTION order_items_quantity_check();

-- A second schema for schema-aware features.
CREATE SCHEMA inventory;

CREATE TABLE inventory.warehouses (
  id SERIAL PRIMARY KEY,
  code VARCHAR(16) NOT NULL UNIQUE,
  city TEXT NOT NULL
);

CREATE TABLE inventory.stock_levels (
  warehouse_id INTEGER NOT NULL REFERENCES inventory.warehouses (id),
  product_id INTEGER NOT NULL REFERENCES public.products (id),
  quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_id, product_id)
);

INSERT INTO inventory.warehouses (id, code, city) VALUES
  (1, 'WH-EU', 'Berlin'),
  (2, 'WH-AS', 'Tashkent');
SELECT setval('inventory.warehouses_id_seq', 2);

INSERT INTO inventory.stock_levels (warehouse_id, product_id, quantity) VALUES
  (1, 1, 70), (1, 2, 200), (2, 1, 50), (2, 3, 15);

-- An empty database for "no tables" cases in the tree.
CREATE DATABASE datanest_empty;
