import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { mysqlDefault } from '../../../../src/drivers/mysql/defaults';
import type { ColumnDesign } from '../../../../src/shared/table-design';

function column(type: string, defaultValue: string): ColumnDesign {
  return {
    id: 'c',
    name: 'c',
    type,
    length: '',
    nullable: true,
    defaultValue,
    autoIncrement: false,
    primaryKey: false,
    comment: '',
  };
}

describe('mysqlDefault', () => {
  it('writes the default of TEXT, BLOB and JSON columns as an expression', () => {
    expect(mysqlDefault(column('longtext', "'new'"))).toBe("('new')");
    expect(mysqlDefault(column('TEXT', '0'))).toBe('(0)');
    expect(mysqlDefault(column('json', "'{}'"))).toBe("('{}')");
    expect(mysqlDefault(column('mediumblob', "x'00'"))).toBe("(x'00')");
  });

  it('leaves other columns, NULL and expressions as they are', () => {
    expect(mysqlDefault(column('varchar', "'new'"))).toBe("'new'");
    expect(mysqlDefault(column('text', 'NULL'))).toBe('NULL');
    expect(mysqlDefault(column('text', "(concat('a'))"))).toBe("(concat('a'))");
  });

  it('is what CREATE TABLE writes', () => {
    const [sql] = mysqlDialect.ddl.createTable(
      { name: 't' },
      {
        name: 't',
        comment: '',
        columns: [column('longtext', "'new'")],
        indexes: [],
        foreignKeys: [],
      },
    );
    expect(sql).toContain("`c` longtext DEFAULT ('new')");
  });
});
