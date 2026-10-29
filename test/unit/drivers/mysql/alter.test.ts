import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { NO_BACKGROUND, type TableDesign } from '../../../../src/shared/table-design';
import { added, column, ordersDesign, withColumn } from '../../../helpers/designs';

const table = { database: 'shop', name: 'orders' };
const before = ordersDesign();

function alter(after: TableDesign, from: TableDesign = before) {
  return mysqlDialect.ddl.alterTable(table, from, after, NO_BACKGROUND);
}

describe('mysql alterTable', () => {
  it('does nothing for an unchanged table', () => {
    expect(alter(structuredClone(before))).toEqual({ statements: [], notes: [], recovery: [] });
  });

  it('renames and redefines a column in place with CHANGE COLUMN', () => {
    const after = withColumn(before, 'note', {
      name: 'remark',
      type: 'text',
      length: '',
      nullable: false,
      defaultValue: "'-'",
      comment: 'free text',
    });
    expect(alter(after).statements).toEqual([
      // MySQL takes a TEXT default only as an expression in parentheses.
      "ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `note` `remark` text NOT NULL DEFAULT ('-') COMMENT 'free text'",
    ]);
  });

  it('adds a column after the one before it, or FIRST', () => {
    expect(alter({ ...before, columns: [...before.columns, added('total')] }).statements).toEqual([
      'ALTER TABLE `shop`.`orders`\n  ADD COLUMN `total` int AFTER `note`',
    ]);
    expect(alter({ ...before, columns: [added('rank'), ...before.columns] }).statements).toEqual([
      'ALTER TABLE `shop`.`orders`\n  ADD COLUMN `rank` int FIRST',
    ]);
  });

  it('moves only the columns that are out of place', () => {
    const [id, customer, note] = before.columns;
    if (id === undefined || customer === undefined || note === undefined) {
      throw new Error('three columns expected');
    }
    // Swapping two neighbours moves one of them, and only that one is rewritten.
    expect(alter({ ...before, columns: [id, note, customer] }).statements).toEqual([
      'ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `note` `note` varchar(40) AFTER `id`',
    ]);
    expect(alter({ ...before, columns: [note, id, customer] }).statements).toEqual([
      'ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `note` `note` varchar(40) FIRST',
    ]);
  });

  it('drops columns and indexes and adds indexes in the same ALTER', () => {
    const after: TableDesign = {
      ...before,
      columns: before.columns.filter((c) => c.name !== 'note'),
      indexes: [{ id: 'i2', name: 'uq_customer', columns: ['customer_id'], unique: true }],
    };
    expect(alter(after).statements).toEqual([
      [
        'ALTER TABLE `shop`.`orders`',
        '  DROP INDEX `ix_note`,',
        '  DROP COLUMN `note`,',
        '  ADD UNIQUE INDEX `uq_customer` (`customer_id`)',
      ].join('\n'),
    ]);
  });

  it('replaces the primary key with DROP and ADD PRIMARY KEY', () => {
    const after = withColumn(before, 'customer_id', { primaryKey: true, nullable: false });
    expect(alter(after).statements).toEqual([
      [
        'ALTER TABLE `shop`.`orders`',
        '  DROP PRIMARY KEY,',
        '  CHANGE COLUMN `customer_id` `customer_id` int NOT NULL,',
        '  ADD PRIMARY KEY (`id`, `customer_id`)',
      ].join('\n'),
    ]);
  });

  it('adds a primary key to a table without one, and removes one', () => {
    const keyless = withColumn(before, 'id', { primaryKey: false });
    expect(alter(before, keyless).statements[0]).not.toContain('DROP PRIMARY KEY');
    expect(alter(before, keyless).statements[0]).toContain('ADD PRIMARY KEY (`id`)');
    expect(alter(keyless).statements[0]).toContain('DROP PRIMARY KEY');
    expect(alter(keyless).statements[0]).not.toContain('ADD PRIMARY KEY');
  });

  it('drops changed keys before the main ALTER and adds them after it', () => {
    const after: TableDesign = {
      ...before,
      foreignKeys: before.foreignKeys.map((k) => ({
        ...k,
        onDelete: 'CASCADE',
        targetSchema: 'crm',
      })),
    };
    expect(alter(after).statements).toEqual([
      'ALTER TABLE `shop`.`orders`\n  DROP FOREIGN KEY `fk_customer`',
      'ALTER TABLE `shop`.`orders`\n  ADD CONSTRAINT `fk_customer` FOREIGN KEY (`customer_id`) REFERENCES `crm`.`customers` (`id`) ON DELETE CASCADE',
    ]);
  });

  it('changes the comment and renames the table last', () => {
    expect(alter({ ...before, name: 'purchases', comment: "it's" }).statements).toEqual([
      "ALTER TABLE `shop`.`orders`\n  COMMENT = 'it''s'",
      'RENAME TABLE `shop`.`orders` TO `shop`.`purchases`',
    ]);
  });

  it('writes auto numbering on a new key column', () => {
    const after = withColumn(before, 'id', { autoIncrement: true });
    expect(alter(after).statements).toEqual([
      'ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `id` `id` int AUTO_INCREMENT NOT NULL',
    ]);
  });

  it('keeps a column untouched when only its neighbour changes', () => {
    const after = withColumn(before, 'customer_id', { comment: 'buyer' });
    const [sql] = alter(after).statements;
    expect(sql).toContain('CHANGE COLUMN `customer_id`');
    expect(sql).not.toContain('`note`');
    expect(sql).not.toContain('`id`');
  });

  it('needs no recovery: MySQL DDL cannot be rolled back', () => {
    expect(alter({ ...before, name: 'x' }).recovery).toEqual([]);
    expect(column('x').original).toBe('x');
  });
});

describe('mysql alterTable: a column placed after a renamed one (V6.5)', () => {
  it('renames first, as TiDB reads AFTER by the names before the statement', () => {
    const renamed = withColumn(before, 'note', { name: 'remark' });
    const after = { ...renamed, columns: [...renamed.columns, added('total')] };
    expect(alter(after).statements).toEqual([
      'ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `note` `remark` varchar(40)',
      'ALTER TABLE `shop`.`orders`\n  ADD COLUMN `total` int AFTER `remark`',
    ]);
  });

  it('keeps one ALTER when nothing is placed after the renamed column', () => {
    const renamed = withColumn(before, 'customer_id', { name: 'client_id' });
    const after = { ...renamed, columns: [added('rank'), ...renamed.columns] };
    expect(alter(after).statements).toEqual([
      'ALTER TABLE `shop`.`orders`\n  ADD COLUMN `rank` int FIRST,\n  CHANGE COLUMN `customer_id` `client_id` int',
    ]);
  });

  it('moves a column after a renamed one once the rename is in', () => {
    const [id, customer, note] = withColumn(before, 'customer_id', { name: 'client_id' }).columns;
    if (id === undefined || customer === undefined || note === undefined) {
      throw new Error('three columns expected');
    }
    expect(alter({ ...before, columns: [customer, note, id] }).statements).toEqual([
      'ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `customer_id` `client_id` int',
      'ALTER TABLE `shop`.`orders`\n  CHANGE COLUMN `client_id` `client_id` int FIRST,\n  CHANGE COLUMN `note` `note` varchar(40) AFTER `client_id`',
    ]);
  });
});
