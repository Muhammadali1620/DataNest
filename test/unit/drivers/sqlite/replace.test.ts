import { describe, expect, it } from 'vitest';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';

const { ddl } = sqliteDialect;

describe('sqlite replaceObject', () => {
  it('drops and creates a view or a trigger in one transaction', () => {
    expect(
      ddl.replaceObject({ kind: 'view', name: 'v' }, ['CREATE VIEW v AS SELECT 2'], []),
    ).toEqual({
      check: [],
      statements: ['BEGIN', 'DROP VIEW IF EXISTS "v"', 'CREATE VIEW v AS SELECT 2', 'COMMIT'],
      recovery: ['ROLLBACK'],
    });
    expect(
      ddl.replaceObject({ database: 'aux', kind: 'trigger', name: 't' }, ['CREATE T'], [])
        .statements[1],
    ).toBe('DROP TRIGGER IF EXISTS "aux"."t"');
  });

  it('refuses what SQLite does not have or edits otherwise', () => {
    for (const kind of ['table', 'function', 'procedure', 'sequence', 'event'] as const) {
      expect(() => ddl.replaceObject({ kind, name: 'x' }, [], [])).toThrow(
        expect.objectContaining({ code: 'unsupported' }),
      );
    }
  });
});
