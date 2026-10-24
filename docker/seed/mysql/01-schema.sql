-- Test data for MySQL 8 and MariaDB. Runs once on container start (as root).
-- Integration tests rely on these exact rows: change them together with test/integration.
SET NAMES utf8mb4;
SET time_zone = '+00:00';

USE datanest_test;

CREATE TABLE customers (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  full_name VARCHAR(255) NULL,
  country CHAR(2) NULL,
  created_at DATETIME NOT NULL DEFAULT '2024-01-01 00:00:00',
  UNIQUE KEY uq_customers_email (email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = 'Shop customers';

CREATE TABLE products (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sku VARCHAR(32) NOT NULL,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(10, 2) NOT NULL,
  stock INT NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  attributes JSON NULL,
  UNIQUE KEY uq_products_sku (sku),
  KEY ix_products_name (name),
  CONSTRAINT ck_products_price CHECK (price >= 0)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  customer_id INT NOT NULL,
  status ENUM('new', 'paid', 'shipped', 'cancelled') NOT NULL DEFAULT 'new',
  ordered_at DATETIME NOT NULL,
  note TEXT NULL,
  KEY ix_orders_customer (customer_id),
  CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

CREATE TABLE order_items (
  order_id INT NOT NULL,
  product_id INT NOT NULL,
  quantity INT NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id),
  CONSTRAINT fk_items_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_items_product FOREIGN KEY (product_id) REFERENCES products (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- One fully filled row and one row of NULLs for value normalization tests.
CREATE TABLE all_types (
  id INT PRIMARY KEY,
  c_tinyint TINYINT NULL,
  c_smallint SMALLINT NULL,
  c_int INT NULL,
  c_bigint BIGINT NULL,
  c_bigint_unsigned BIGINT UNSIGNED NULL,
  c_decimal DECIMAL(30, 10) NULL,
  c_float FLOAT NULL,
  c_double DOUBLE NULL,
  c_bit BIT(8) NULL,
  c_bool BOOLEAN NULL,
  c_char CHAR(3) NULL,
  c_varchar VARCHAR(255) NULL,
  c_text TEXT NULL,
  c_date DATE NULL,
  c_time TIME NULL,
  c_datetime DATETIME(6) NULL,
  c_timestamp TIMESTAMP NULL,
  c_year YEAR NULL,
  c_enum ENUM('a', 'b') NULL,
  c_set SET('x', 'y', 'z') NULL,
  c_json JSON NULL,
  c_binary VARBINARY(16) NULL,
  c_blob BLOB NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 10 000 rows for pagination and streaming tests.
CREATE TABLE big_table (
  id INT PRIMARY KEY,
  label VARCHAR(32) NOT NULL,
  value_mod INT NOT NULL,
  KEY ix_big_value_mod (value_mod)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT INTO customers (id, email, full_name, country, created_at) VALUES
  (1, 'alice@example.com', 'Alice Johnson', 'US', '2024-01-02 08:00:00'),
  (2, 'bob@example.com', 'Bob O''Brien', 'IE', '2024-01-03 09:30:00'),
  (3, 'olga@example.com', 'Ольга Иванова', 'RU', '2024-02-10 12:00:00'),
  (4, 'hiro@example.com', '山田 博', 'JP', '2024-03-05 15:45:00'),
  (5, 'noname@example.com', NULL, NULL, '2024-04-01 00:00:00');

INSERT INTO products (id, sku, name, price, stock, is_active, attributes) VALUES
  (1, 'SKU-001', 'Keyboard', 49.99, 120, TRUE, '{"color": "black", "layout": "US"}'),
  (2, 'SKU-002', 'Mouse', 19.50, 300, TRUE, '{"dpi": 1600}'),
  (3, 'SKU-003', 'Monitor 27"', 329.00, 15, TRUE, '{"size": 27, "panel": "IPS"}'),
  (4, 'SKU-004', 'USB-C Cable', 9.99, 0, FALSE, NULL),
  (5, 'SKU-005', 'Rocket Mug 🚀', 12.00, 42, TRUE, '{"emoji": "🚀"}'),
  (6, 'SKU-006', 'Desk Lamp', 35.25, 7, TRUE, '{}');

INSERT INTO orders (id, customer_id, status, ordered_at, note) VALUES
  (1, 1, 'paid', '2024-01-15 10:00:00', NULL),
  (2, 1, 'shipped', '2024-02-01 12:30:00', 'Leave at the door'),
  (3, 2, 'new', '2024-03-10 09:15:00', NULL),
  (4, 3, 'paid', '2024-03-11 18:45:00', 'Позвонить заранее'),
  (5, 3, 'cancelled', '2024-04-02 08:00:00', NULL),
  (6, 4, 'shipped', '2024-05-20 23:59:59', NULL),
  (7, 2, 'paid', '2024-06-01 00:00:00', NULL),
  (8, 5, 'new', '2024-06-15 14:00:00', NULL);

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
  1, 127, 32767, 2147483647, 9223372036854775807, 18446744073709551615,
  12345678901234567890.0123456789, 1.5, 3.141592653589793, b'10100101', TRUE,
  'abc', 'O''Brien "quoted" \\ backslash', 'Многострочный\nтекст 🚀',
  '2024-02-29', '23:59:59', '2024-12-31 23:59:59.123456', '2024-06-15 12:00:00', 2024,
  'b', 'x,z', '{"nested": {"list": [1, 2, 3]}, "unicode": "日本語"}',
  0xDEADBEEF, 0x00FF00FF
);
INSERT INTO all_types (id) VALUES (2);

INSERT INTO big_table (id, label, value_mod)
SELECT n, CONCAT('row-', LPAD(n, 5, '0')), n % 100
FROM (
  SELECT a.d + b.d * 10 + c.d * 100 + e.d * 1000 + 1 AS n
  FROM (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
        UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) a
  CROSS JOIN (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
        UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) b
  CROSS JOIN (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
        UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) c
  CROSS JOIN (SELECT 0 AS d UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4
        UNION ALL SELECT 5 UNION ALL SELECT 6 UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9) e
) numbers;

CREATE VIEW order_totals AS
SELECT o.id AS order_id, o.customer_id, o.status, SUM(i.quantity * i.unit_price) AS total
FROM orders o
JOIN order_items i ON i.order_id = o.id
GROUP BY o.id, o.customer_id, o.status;

DELIMITER //

CREATE FUNCTION order_total(p_order_id INT) RETURNS DECIMAL(12, 2)
READS SQL DATA
BEGIN
  DECLARE result DECIMAL(12, 2);
  SELECT COALESCE(SUM(quantity * unit_price), 0) INTO result
  FROM order_items WHERE order_id = p_order_id;
  RETURN result;
END //

CREATE PROCEDURE customer_orders(IN p_customer_id INT)
READS SQL DATA
BEGIN
  SELECT id, status, ordered_at FROM orders WHERE customer_id = p_customer_id ORDER BY id;
END //

CREATE TRIGGER order_items_quantity_check
BEFORE INSERT ON order_items
FOR EACH ROW
BEGIN
  IF NEW.quantity <= 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'quantity must be positive';
  END IF;
END //

DELIMITER ;

-- An empty database for "no tables" cases in the tree.
CREATE DATABASE datanest_empty DEFAULT CHARSET = utf8mb4;
GRANT ALL PRIVILEGES ON datanest_empty.* TO 'datanest'@'%';
FLUSH PRIVILEGES;
