import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';

const { ddl } = mysqlDialect;
const table = { database: 'shop', name: 'orders' };

describe('mysql ddl', () => {
  it('creates and drops databases, and has no schemas', () => {
    expect(ddl.createDatabase?.('new`db')).toBe('CREATE DATABASE `new``db`');
    expect(ddl.dropDatabase?.('shop')).toBe('DROP DATABASE `shop`');
    expect(ddl.createSchema).toBeUndefined();
    expect(ddl.dropSchema).toBeUndefined();
  });

  it('creates a table with an auto-increment key', () => {
    expect(ddl.createTableStub(table)).toBe(
      'CREATE TABLE `shop`.`orders` (\n  `id` INT NOT NULL AUTO_INCREMENT PRIMARY KEY\n)',
    );
    expect(ddl.createTableStub({ name: 'loose' })).toMatch(/^CREATE TABLE `loose` \(/);
  });

  it('drops, renames and empties tables and views', () => {
    expect(ddl.dropRelation(table, 'table')).toBe('DROP TABLE `shop`.`orders`');
    expect(ddl.dropRelation(table, 'view')).toBe('DROP VIEW `shop`.`orders`');
    expect(ddl.renameRelation(table, 'table', 'orders_old')).toBe(
      'RENAME TABLE `shop`.`orders` TO `shop`.`orders_old`',
    );
    expect(ddl.renameRelation({ name: 'v' }, 'view', 'w')).toBe('RENAME TABLE `v` TO `w`');
    expect(ddl.truncateTable(table)).toBe('TRUNCATE TABLE `shop`.`orders`');
  });

  it('drops every other kind by its own keyword', () => {
    for (const kind of ['function', 'procedure', 'trigger', 'event', 'sequence'] as const) {
      expect(ddl.dropObject({ database: 'shop', kind, name: 'x' })).toBe(
        `DROP ${kind.toUpperCase()} \`shop\`.\`x\``,
      );
    }
    expect(ddl.dropObject({ kind: 'view', name: 'v' })).toBe('DROP VIEW `v`');
    expect(ddl.dropObject({ kind: 'table', name: 't' })).toBe('DROP TABLE `t`');
  });

  it('refuses an empty name instead of writing broken SQL', () => {
    expect(() => ddl.createDatabase?.('')).toThrow('Identifier must not be empty');
  });
});
