-- Test data for SQL Server (V6.2). Run once by docker/mssql/entrypoint.sh with sqlcmd, as sa.
-- Mirrors docker/seed/postgres with the same rows, plus SQL Server types and objects.
-- Integration tests rely on these exact rows: change them together with test/integration.
SET NOCOUNT ON;
GO

-- A plain password is allowed for a login without the policy check: tests stay
-- symmetrical with the other servers (user datanest, password datanest).
CREATE LOGIN datanest WITH PASSWORD = 'datanest', CHECK_POLICY = OFF, CHECK_EXPIRATION = OFF;
ALTER SERVER ROLE dbcreator ADD MEMBER datanest;
-- Ending another session's statement and reading sessions (cancel tests, V8 monitoring).
GRANT VIEW SERVER STATE TO datanest;
GO

CREATE DATABASE datanest_test;
CREATE DATABASE datanest_empty;
GO

USE datanest_empty;
CREATE USER datanest FOR LOGIN datanest;
ALTER ROLE db_owner ADD MEMBER datanest;
GO

USE datanest_test;
CREATE USER datanest FOR LOGIN datanest;
ALTER ROLE db_owner ADD MEMBER datanest;
GO

CREATE TABLE customers (
  id INT IDENTITY(1, 1) PRIMARY KEY,
  email NVARCHAR(255) NOT NULL UNIQUE,
  full_name NVARCHAR(255),
  country CHAR(2),
  created_at DATETIME2(0) NOT NULL DEFAULT '2024-01-01 00:00:00'
);
EXEC sp_addextendedproperty N'MS_Description', N'Shop customers',
  N'SCHEMA', N'dbo', N'TABLE', N'customers';

CREATE TABLE products (
  id INT IDENTITY(1, 1) PRIMARY KEY,
  sku VARCHAR(32) NOT NULL UNIQUE,
  name NVARCHAR(255) NOT NULL,
  price DECIMAL(10, 2) NOT NULL CHECK (price >= 0),
  stock INT NOT NULL DEFAULT 0,
  is_active BIT NOT NULL DEFAULT 1,
  attributes NVARCHAR(MAX) CHECK (attributes IS NULL OR ISJSON(attributes) = 1)
);
CREATE INDEX ix_products_name ON products (name);

CREATE TABLE orders (
  id INT IDENTITY(1, 1) PRIMARY KEY,
  customer_id INT NOT NULL REFERENCES customers (id),
  status VARCHAR(16) NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'paid', 'shipped', 'cancelled')),
  ordered_at DATETIME2(0) NOT NULL,
  note NVARCHAR(MAX)
);
CREATE INDEX ix_orders_customer ON orders (customer_id);

CREATE TABLE order_items (
  order_id INT NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products (id),
  quantity INT NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL,
  PRIMARY KEY (order_id, product_id)
);

-- One fully filled row and one row of NULLs for value normalization tests.
CREATE TABLE all_types (
  id INT PRIMARY KEY,
  c_tinyint TINYINT,
  c_smallint SMALLINT,
  c_int INT,
  c_bigint BIGINT,
  c_decimal DECIMAL(30, 10),
  c_numeric NUMERIC(38, 0),
  c_money MONEY,
  c_smallmoney SMALLMONEY,
  c_real REAL,
  c_float FLOAT,
  c_bit BIT,
  c_char CHAR(3),
  c_varchar VARCHAR(255),
  c_nchar NCHAR(3),
  c_nvarchar NVARCHAR(MAX),
  c_date DATE,
  c_time TIME(7),
  c_datetime DATETIME,
  c_smalldatetime SMALLDATETIME,
  c_datetime2 DATETIME2(7),
  c_datetimeoffset DATETIMEOFFSET(7),
  c_uniqueidentifier UNIQUEIDENTIFIER,
  c_binary BINARY(4),
  c_varbinary VARBINARY(MAX),
  c_xml XML
);

-- 10 000 rows for pagination and streaming tests.
CREATE TABLE big_table (
  id INT PRIMARY KEY,
  label VARCHAR(32) NOT NULL,
  value_mod INT NOT NULL
);
CREATE INDEX ix_big_value_mod ON big_table (value_mod);
GO

SET IDENTITY_INSERT customers ON;
INSERT INTO customers (id, email, full_name, country, created_at) VALUES
  (1, N'alice@example.com', N'Alice Johnson', 'US', '2024-01-02 08:00:00'),
  (2, N'bob@example.com', N'Bob O''Brien', 'IE', '2024-01-03 09:30:00'),
  (3, N'olga@example.com', N'Ольга Иванова', 'RU', '2024-02-10 12:00:00'),
  (4, N'hiro@example.com', N'山田 博', 'JP', '2024-03-05 15:45:00'),
  (5, N'noname@example.com', NULL, NULL, '2024-04-01 00:00:00');
SET IDENTITY_INSERT customers OFF;

SET IDENTITY_INSERT products ON;
INSERT INTO products (id, sku, name, price, stock, is_active, attributes) VALUES
  (1, 'SKU-001', N'Keyboard', 49.99, 120, 1, N'{"color": "black", "layout": "US"}'),
  (2, 'SKU-002', N'Mouse', 19.50, 300, 1, N'{"dpi": 1600}'),
  (3, 'SKU-003', N'Monitor 27"', 329.00, 15, 1, N'{"size": 27, "panel": "IPS"}'),
  (4, 'SKU-004', N'USB-C Cable', 9.99, 0, 0, NULL),
  (5, 'SKU-005', N'Rocket Mug 🚀', 12.00, 42, 1, N'{"emoji": "🚀"}'),
  (6, 'SKU-006', N'Desk Lamp', 35.25, 7, 1, N'{}');
SET IDENTITY_INSERT products OFF;

SET IDENTITY_INSERT orders ON;
INSERT INTO orders (id, customer_id, status, ordered_at, note) VALUES
  (1, 1, 'paid', '2024-01-15 10:00:00', NULL),
  (2, 1, 'shipped', '2024-02-01 12:30:00', N'Leave at the door'),
  (3, 2, 'new', '2024-03-10 09:15:00', NULL),
  (4, 3, 'paid', '2024-03-11 18:45:00', N'Позвонить заранее'),
  (5, 3, 'cancelled', '2024-04-02 08:00:00', NULL),
  (6, 4, 'shipped', '2024-05-20 23:59:59', NULL),
  (7, 2, 'paid', '2024-06-01 00:00:00', NULL),
  (8, 5, 'new', '2024-06-15 14:00:00', NULL);
SET IDENTITY_INSERT orders OFF;

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
  1, 255, 32767, 2147483647, 9223372036854775807, 12345678901234567890.0123456789,
  12345678901234567890123456789012345678, 922337203685477.5807, -214748.3648,
  1.5, 3.141592653589793, 1, 'abc', 'O''Brien "quoted" \ backslash', N'äöü',
  N'Многострочный' + NCHAR(10) + N'текст 🚀', '2024-02-29', '23:59:59.1234567',
  '2024-12-31 23:59:59.997', '2024-12-31 23:59:00', '2024-12-31 23:59:59.1234567',
  '2024-06-15 12:00:00.1234567 +03:00', 'A0EEBC99-9C0B-4EF8-BB6D-6BB9BD380A11',
  0xDEADBEEF, 0xCAFEBABE00, N'<root><item id="1">日本語</item></root>'
);
INSERT INTO all_types (id) VALUES (2);

WITH numbers AS (
  SELECT TOP (10000) ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n
  FROM sys.all_objects a CROSS JOIN sys.all_objects b
)
INSERT INTO big_table (id, label, value_mod)
SELECT n, 'row-' + RIGHT('00000' + CAST(n AS VARCHAR(5)), 5), n % 100
FROM numbers;
GO

CREATE VIEW order_totals AS
SELECT o.id AS order_id, o.customer_id, o.status, SUM(i.quantity * i.unit_price) AS total
FROM orders o
JOIN order_items i ON i.order_id = o.id
GROUP BY o.id, o.customer_id, o.status;
GO

CREATE SEQUENCE invoice_number_seq START WITH 1000;
GO

CREATE FUNCTION order_total(@order_id INT) RETURNS DECIMAL(12, 2)
AS
BEGIN
  RETURN (SELECT COALESCE(SUM(quantity * unit_price), 0) FROM order_items WHERE order_id = @order_id);
END;
GO

CREATE PROCEDURE restock @product_id INT, @amount INT
AS
BEGIN
  SET NOCOUNT ON;
  UPDATE products SET stock = stock + @amount WHERE id = @product_id;
END;
GO

CREATE PROCEDURE customer_orders @customer_id INT
AS
BEGIN
  SET NOCOUNT ON;
  SELECT id, status FROM orders WHERE customer_id = @customer_id ORDER BY id;
END;
GO

CREATE TRIGGER order_items_quantity_check ON order_items
AFTER INSERT, UPDATE
AS
BEGIN
  IF EXISTS (SELECT 1 FROM inserted WHERE quantity <= 0)
  BEGIN
    THROW 50001, 'quantity must be positive', 1;
  END;
END;
GO

-- A second schema for schema-aware features.
CREATE SCHEMA inventory;
GO

CREATE TABLE inventory.warehouses (
  id INT IDENTITY(1, 1) PRIMARY KEY,
  code VARCHAR(16) NOT NULL UNIQUE,
  city NVARCHAR(100) NOT NULL
);

CREATE TABLE inventory.stock_levels (
  warehouse_id INT NOT NULL REFERENCES inventory.warehouses (id),
  product_id INT NOT NULL REFERENCES dbo.products (id),
  quantity INT NOT NULL DEFAULT 0,
  PRIMARY KEY (warehouse_id, product_id)
);
GO

SET IDENTITY_INSERT inventory.warehouses ON;
INSERT INTO inventory.warehouses (id, code, city) VALUES
  (1, 'WH-EU', N'Berlin'),
  (2, 'WH-AS', N'Tashkent');
SET IDENTITY_INSERT inventory.warehouses OFF;

INSERT INTO inventory.stock_levels (warehouse_id, product_id, quantity) VALUES
  (1, 1, 70), (1, 2, 200), (2, 1, 50), (2, 3, 15);
GO
