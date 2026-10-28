import { describe, expect, it } from 'vitest';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';

const { ddl } = postgresDialect;
const FN = 'CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 2 $$';

describe('postgres replaceObject', () => {
  it('replaces a routine or a view in a transaction, with nothing dropped', () => {
    for (const kind of ['function', 'procedure', 'view'] as const) {
      expect(ddl.replaceObject({ kind, name: 'f' }, [FN], ['OLD'])).toEqual({
        check: [],
        statements: ['BEGIN', FN, 'COMMIT'],
        recovery: ['ROLLBACK'],
      });
    }
  });

  it('drops a materialized view first: it has no OR REPLACE', () => {
    expect(
      ddl.replaceObject(
        { schema: 's', kind: 'view', name: 'mv', materialized: true },
        ['CREATE MV'],
        [],
      ).statements,
    ).toEqual(['BEGIN', 'DROP MATERIALIZED VIEW IF EXISTS "s"."mv"', 'CREATE MV', 'COMMIT']);
  });

  it('drops a trigger on its table first', () => {
    expect(
      ddl.replaceObject(
        { schema: 's', kind: 'trigger', name: 't', table: 'orders' },
        ['CREATE T'],
        [],
      ).statements,
    ).toEqual(['BEGIN', 'DROP TRIGGER IF EXISTS "t" ON "s"."orders"', 'CREATE T', 'COMMIT']);
    expect(() => ddl.replaceObject({ kind: 'trigger', name: 't' }, [], [])).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });

  it('refuses tables, sequences and events', () => {
    for (const kind of ['table', 'sequence', 'event'] as const) {
      expect(() => ddl.replaceObject({ kind, name: 'x' }, [], [])).toThrow(
        expect.objectContaining({ code: 'unsupported' }),
      );
    }
  });
});
