import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { newTableDesign } from '../../../../src/shared/table-design';

const { ddl } = mysqlDialect;
const table = { database: 'shop', name: 'orders' };

describe('mysql ddl', () => {
  it('creates and drops databases, and has no schemas', () => {
    expect(ddl.createDatabase?.('new`db')).toBe('CREATE DATABASE `new``db`');
    expect(ddl.dropDatabase?.('shop')).toBe('DROP DATABASE `shop`');
    expect(ddl.createSchema).toBeUndefined();
    expect(ddl.dropSchema).toBeUndefined();
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

  describe('createTable', () => {
    it('writes keys, auto numbering, defaults and comments inline', () => {
      const design = newTableDesign('mysql', 'orders');
      expect(
        ddl.createTable(table, {
          ...design,
          comment: "it's mine",
          columns: [
            ...design.columns,
            {
              id: 'n',
              name: 'note',
              type: 'varchar',
              length: '40',
              nullable: false,
              defaultValue: "'x'",
              autoIncrement: false,
              primaryKey: false,
              comment: 'a \\ b',
            },
          ],
        }),
      ).toEqual([
        [
          'CREATE TABLE `shop`.`orders` (',
          '  `id` int AUTO_INCREMENT NOT NULL,',
          "  `note` varchar(40) NOT NULL DEFAULT 'x' COMMENT 'a \\\\ b',",
          '  PRIMARY KEY (`id`)',
          ") COMMENT = 'it''s mine'",
        ].join('\n'),
      ]);
    });

    it('takes the name from the design, not from the reference', () => {
      const [sql] = ddl.createTable(
        { database: 'shop', name: 'old' },
        newTableDesign('mysql', ' new '),
      );
      expect(sql).toMatch(/^CREATE TABLE `shop`.`new` \(/);
    });

    it('offers MySQL types and both kinds of comments', () => {
      expect(ddl.designer.types).toContain('int unsigned');
      expect(ddl.designer.types).toContain('enum');
      expect(ddl.designer.columnComments).toBe(true);
      expect(ddl.designer.tableComment).toBe(true);
    });
  });
});
