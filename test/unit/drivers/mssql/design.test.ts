import { describe, expect, it } from 'vitest';
import {
  mssqlColumnSql,
  renameTarget,
  withoutRestrict,
} from '../../../../src/drivers/mssql/design';
import type { ForeignKeyDesign } from '../../../../src/shared/table-design';
import { column } from '../../../helpers/designs';

const key: ForeignKeyDesign = {
  id: 'k',
  name: 'fk',
  columns: ['a'],
  targetTable: 't',
  targetColumns: ['id'],
  onDelete: 'RESTRICT',
  onUpdate: 'RESTRICT',
};

describe('withoutRestrict', () => {
  it('turns RESTRICT into NO ACTION, which SQL Server spells', () => {
    expect(withoutRestrict(key)).toMatchObject({ onDelete: 'NO ACTION', onUpdate: 'NO ACTION' });
  });

  it('keeps every other action', () => {
    const cascade = { ...key, onDelete: 'CASCADE', onUpdate: 'SET NULL' } as const;
    expect(withoutRestrict(cascade)).toEqual(cascade);
  });
});

describe('mssqlColumnSql', () => {
  it('writes IDENTITY after the type and before NOT NULL', () => {
    expect(
      mssqlColumnSql(
        column('id', { type: 'int', autoIncrement: true, primaryKey: true, nullable: false }),
      ),
    ).toBe('[id] int IDENTITY(1, 1) NOT NULL');
  });

  it('writes the length and the default', () => {
    expect(
      mssqlColumnSql(column('name', { type: 'nvarchar', length: 'max', defaultValue: "N'x'" })),
    ).toBe("[name] nvarchar(max) DEFAULT N'x'");
  });
});

describe('renameTarget', () => {
  it('names the object for sp_rename as one string of quoted parts', () => {
    expect(renameTarget(['dbo', 'orders', 'old'])).toBe("N'[dbo].[orders].[old]'");
    expect(renameTarget(["o'x", 'a]b'])).toBe("N'[o''x].[a]]b]'");
  });
});
