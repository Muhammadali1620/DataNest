import { describe, expect, it } from 'vitest';
import type { ColumnDetail, ForeignKey, IndexInfo } from '../../../../src/core/model/objects';
import {
  columnSql,
  foreignKeySql,
  indexSql,
  triggerStatements,
} from '../../../../src/drivers/common/node-sql';
import { clickhouseDialect } from '../../../../src/drivers/clickhouse/dialect';
import { mssqlDialect } from '../../../../src/drivers/mssql/dialect';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { oracleDialect } from '../../../../src/drivers/oracle/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';

const column: ColumnDetail = {
  name: 'user_id',
  dataType: 'bigint',
  nullable: false,
  autoIncrement: false,
  generated: false,
  comment: "owner's id",
};

describe('columnSql', () => {
  it('writes the type, nullability, default, rename and comment for PostgreSQL', () => {
    const sql = columnSql(
      'postgres',
      postgresDialect,
      { schema: 'public', name: 'club_accounts' },
      { ...column, defaultExpression: '0' },
    );
    expect(sql).toBe(
      [
        'ALTER TABLE "public"."club_accounts"',
        '    ALTER COLUMN "user_id" TYPE bigint;',
        '-- change nullability',
        'ALTER TABLE "public"."club_accounts" ALTER COLUMN "user_id" SET NOT NULL;',
        '-- change the default',
        'ALTER TABLE "public"."club_accounts" ALTER COLUMN "user_id" SET DEFAULT 0;',
        '-- change column name',
        'ALTER TABLE "public"."club_accounts" RENAME COLUMN "user_id" TO "user_id";',
        '-- change column comment',
        `COMMENT ON COLUMN "public"."club_accounts"."user_id" IS 'owner''s id';`,
        '',
      ].join('\n'),
    );
  });

  it('drops the NOT NULL and the default of a nullable PostgreSQL column without them', () => {
    const sql = columnSql(
      'postgres',
      postgresDialect,
      { schema: 's', name: 't' },
      { name: 'c', dataType: 'text', nullable: true, autoIncrement: false, generated: false },
    );
    expect(sql).toContain('ALTER COLUMN "c" DROP NOT NULL;');
    expect(sql).toContain('ALTER COLUMN "c" DROP DEFAULT;');
    expect(sql).toContain('COMMENT ON COLUMN "s"."t"."c" IS NULL;');
  });

  it('writes MODIFY COLUMN with the whole definition for MySQL', () => {
    const sql = columnSql(
      'mysql',
      mysqlDialect,
      { database: 'app', name: 'orders' },
      { ...column, dataType: 'bigint unsigned', autoIncrement: true, defaultExpression: '1' },
    );
    expect(sql).toBe(
      [
        'ALTER TABLE `app`.`orders`',
        "    MODIFY COLUMN `user_id` bigint unsigned NOT NULL DEFAULT 1 AUTO_INCREMENT COMMENT 'owner''s id';",
        '-- change column name',
        'ALTER TABLE `app`.`orders` RENAME COLUMN `user_id` TO `user_id`;',
        '',
      ].join('\n'),
    );
  });

  it('leaves the comment clause out when the column has none (MySQL)', () => {
    const sql = columnSql(
      'mysql',
      mysqlDialect,
      { name: 'orders' },
      { name: 'a', dataType: 'int', nullable: true, autoIncrement: false, generated: false },
    );
    expect(sql).toContain('MODIFY COLUMN `a` int NULL;');
    expect(sql).not.toContain('COMMENT');
  });

  it('renames with sp_rename for SQL Server, by schema, table and column', () => {
    const sql = columnSql(
      'mssql',
      mssqlDialect,
      { database: 'app', schema: 'dbo', name: 'orders' },
      { ...column, dataType: 'bigint', nullable: true },
    );
    expect(sql).toContain('ALTER COLUMN [user_id] bigint NULL;');
    expect(sql).toContain("EXEC sp_rename N'dbo.orders.user_id', N'user_id', 'COLUMN';");
  });

  it('uses MODIFY, RENAME COLUMN and COMMENT ON for Oracle', () => {
    const sql = columnSql('oracle', oracleDialect, { schema: 'HR', name: 'EMP' }, column);
    expect(sql).toContain('MODIFY ("user_id" bigint);');
    expect(sql).toContain('RENAME COLUMN "user_id" TO "user_id";');
    expect(sql).toContain('COMMENT ON COLUMN "HR"."EMP"."user_id" IS \'owner\'\'s id\';');
  });

  it('modifies, renames and comments with ClickHouse words', () => {
    const sql = columnSql(
      'clickhouse',
      clickhouseDialect,
      { database: 'app', name: 'events' },
      { ...column, dataType: 'Nullable(String)' },
    );
    expect(sql).toContain("MODIFY COLUMN `user_id` Nullable(String) COMMENT 'owner\\'s id';");
    expect(sql).toContain('RENAME COLUMN `user_id` TO `user_id`;');
    expect(sql).toContain("COMMENT COLUMN `user_id` 'owner\\'s id';");
  });

  it('explains what SQLite cannot do and offers the rename', () => {
    const sql = columnSql('sqlite', sqliteDialect, { name: 'orders' }, column);
    expect(sql).toContain('-- SQLite changes the type');
    expect(sql).toContain('ALTER TABLE "orders" RENAME COLUMN "user_id" TO "user_id";');
    expect(sql).not.toContain('MODIFY');
  });

  it('quotes names that need it', () => {
    const sql = columnSql(
      'postgres',
      postgresDialect,
      { schema: 'My Schema', name: 'we"ird' },
      { ...column, name: 'Mixed Case' },
    );
    expect(sql).toContain('ALTER TABLE "My Schema"."we""ird"');
    expect(sql).toContain('ALTER COLUMN "Mixed Case" TYPE bigint;');
  });

  it('refuses a driver without SQL columns', () => {
    expect(() => columnSql('redis', postgresDialect, { name: 't' }, column)).toThrow();
  });
});

describe('indexSql', () => {
  const index: IndexInfo = {
    name: 'ix_user',
    columns: ['user_id', 'created_at'],
    unique: false,
    primary: false,
  };
  const table = { database: 'app', schema: 'public', name: 'orders' };

  it('drops and creates a PostgreSQL index with its method and condition', () => {
    const sql = indexSql('postgres', postgresDialect, table, {
      ...index,
      unique: true,
      method: 'btree',
      where: 'deleted_at IS NULL',
    });
    expect(sql).toBe(
      [
        'DROP INDEX "public"."ix_user";',
        'CREATE UNIQUE INDEX "ix_user" ON "public"."orders" USING btree ("user_id", "created_at") WHERE deleted_at IS NULL;',
        '',
      ].join('\n'),
    );
  });

  it('rewrites the constraint behind a PostgreSQL primary or unique key', () => {
    const primary = indexSql('postgres', postgresDialect, table, {
      name: 'orders_pkey',
      columns: ['id'],
      unique: true,
      primary: true,
    });
    expect(primary).toBe(
      [
        'ALTER TABLE "public"."orders" DROP CONSTRAINT "orders_pkey";',
        'ALTER TABLE "public"."orders" ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");',
        '',
      ].join('\n'),
    );
    const unique = indexSql('postgres', postgresDialect, table, {
      ...index,
      unique: true,
      constraint: true,
    });
    expect(unique).toContain('ADD CONSTRAINT "ix_user" UNIQUE ("user_id", "created_at");');
  });

  it('writes expressions as they are and plain names quoted', () => {
    const sql = indexSql('postgres', postgresDialect, table, {
      ...index,
      columns: ['lower(email)', 'Name'],
    });
    expect(sql).toContain('("lower(email)"'.slice(0, 1) + 'lower(email), "Name")');
  });

  it('uses DROP INDEX … ON for MySQL, with FULLTEXT and USING', () => {
    const plain = indexSql(
      'mysql',
      mysqlDialect,
      { database: 'app', name: 'orders' },
      {
        ...index,
        unique: true,
        method: 'BTREE',
      },
    );
    expect(plain).toBe(
      [
        'DROP INDEX `ix_user` ON `app`.`orders`;',
        'CREATE UNIQUE INDEX `ix_user` ON `app`.`orders` (`user_id`, `created_at`) USING BTREE;',
        '',
      ].join('\n'),
    );
    const text = indexSql(
      'mysql',
      mysqlDialect,
      { name: 'orders' },
      {
        ...index,
        columns: ['body'],
        method: 'FULLTEXT',
      },
    );
    expect(text).toContain('CREATE FULLTEXT INDEX `ix_user` ON `orders` (`body`);');
  });

  it('drops and adds the primary key of a MySQL table', () => {
    const sql = indexSql(
      'mysql',
      mysqlDialect,
      { name: 'orders' },
      {
        name: 'PRIMARY',
        columns: ['id'],
        unique: true,
        primary: true,
      },
    );
    expect(sql).toBe(
      [
        'ALTER TABLE `orders` DROP PRIMARY KEY;',
        'ALTER TABLE `orders` ADD PRIMARY KEY (`id`);',
        '',
      ].join('\n'),
    );
  });

  it('writes SQL Server and Oracle and SQLite indexes in their own way', () => {
    expect(
      indexSql(
        'mssql',
        mssqlDialect,
        { schema: 'dbo', name: 'orders' },
        { ...index, unique: true },
      ),
    ).toContain(
      'CREATE UNIQUE NONCLUSTERED INDEX [ix_user] ON [dbo].[orders] ([user_id], [created_at]);',
    );
    expect(indexSql('oracle', oracleDialect, { schema: 'HR', name: 'EMP' }, index)).toContain(
      'DROP INDEX "HR"."ix_user";',
    );
    expect(indexSql('sqlite', sqliteDialect, { name: 'orders' }, index)).toBe(
      [
        'DROP INDEX "ix_user";',
        'CREATE INDEX "ix_user" ON "orders" ("user_id", "created_at");',
        '',
      ].join('\n'),
    );
  });

  it('says where the primary key of SQLite and ClickHouse is changed', () => {
    const primary: IndexInfo = { name: 'pk', columns: ['id'], unique: true, primary: true };
    expect(indexSql('sqlite', sqliteDialect, { name: 't' }, primary)).toContain('table designer');
    expect(indexSql('clickhouse', clickhouseDialect, { name: 't' }, primary)).toContain(
      'sorting key',
    );
  });

  it('adds a ClickHouse data-skipping index with its type', () => {
    const sql = indexSql(
      'clickhouse',
      clickhouseDialect,
      { database: 'app', name: 'events' },
      {
        ...index,
        method: 'bloom_filter',
      },
    );
    expect(sql).toContain('ALTER TABLE `app`.`events` DROP INDEX `ix_user`;');
    expect(sql).toContain('TYPE bloom_filter GRANULARITY 1;');
  });
});

describe('foreignKeySql', () => {
  const key: ForeignKey = {
    name: 'fk_user',
    columns: ['user_id'],
    target: { schema: 'public', name: 'users' },
    targetColumns: ['id'],
    onDelete: 'CASCADE',
    onUpdate: 'NO ACTION',
  };

  it('drops the constraint and adds it again with its actions (PostgreSQL)', () => {
    expect(
      foreignKeySql('postgres', postgresDialect, { schema: 'public', name: 'orders' }, key),
    ).toBe(
      [
        'ALTER TABLE "public"."orders" DROP CONSTRAINT "fk_user";',
        'ALTER TABLE "public"."orders" ADD CONSTRAINT "fk_user" FOREIGN KEY ("user_id") REFERENCES "public"."users" ("id") ON DELETE CASCADE;',
        '',
      ].join('\n'),
    );
  });

  it('uses DROP FOREIGN KEY for MySQL and keeps both actions', () => {
    const sql = foreignKeySql(
      'mysql',
      mysqlDialect,
      { database: 'app', name: 'orders' },
      { ...key, target: { database: 'app', name: 'users' }, onUpdate: 'SET NULL' },
    );
    expect(sql).toContain('DROP FOREIGN KEY `fk_user`;');
    expect(sql).toContain('ON DELETE CASCADE ON UPDATE SET NULL;');
  });

  it('leaves ON UPDATE out for Oracle, which has none', () => {
    const sql = foreignKeySql(
      'oracle',
      oracleDialect,
      { schema: 'HR', name: 'EMP' },
      {
        ...key,
        onUpdate: 'CASCADE',
      },
    );
    expect(sql).toContain('ON DELETE CASCADE;');
    expect(sql).not.toContain('ON UPDATE');
  });

  it('keeps composite keys in order', () => {
    const sql = foreignKeySql(
      'mssql',
      mssqlDialect,
      { schema: 'dbo', name: 'orders' },
      {
        ...key,
        columns: ['a', 'b'],
        targetColumns: ['x', 'y'],
      },
    );
    expect(sql).toContain('FOREIGN KEY ([a], [b]) REFERENCES [public].[users] ([x], [y])');
  });

  it('comments the statement out for SQLite and explains ClickHouse', () => {
    const sqlite = foreignKeySql('sqlite', sqliteDialect, { name: 'orders' }, key);
    expect(sqlite).toContain('table designer');
    expect(sqlite).toMatch(/^-- ALTER TABLE "orders" ADD CONSTRAINT/mu);
    expect(foreignKeySql('clickhouse', clickhouseDialect, { name: 'orders' }, key)).toContain(
      'no foreign keys',
    );
  });
});

describe('triggerStatements', () => {
  it('turns CREATE TRIGGER into CREATE OR REPLACE TRIGGER for PostgreSQL only', () => {
    const create = 'CREATE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f()';
    expect(triggerStatements('postgres', [create])).toEqual([
      'CREATE OR REPLACE TRIGGER t BEFORE INSERT ON a FOR EACH ROW EXECUTE FUNCTION f()',
    ]);
    expect(triggerStatements('postgres', [`  create   trigger x ${create}`])[0]).toMatch(
      /^ {2}CREATE OR REPLACE TRIGGER x/u,
    );
    expect(triggerStatements('mysql', [create])).toEqual([create]);
    expect(triggerStatements('postgres', ['COMMENT ON TRIGGER t ON a IS 1'])).toEqual([
      'COMMENT ON TRIGGER t ON a IS 1',
    ]);
  });
});
