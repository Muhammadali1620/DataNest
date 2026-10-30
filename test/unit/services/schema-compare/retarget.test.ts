import { describe, expect, it } from 'vitest';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import {
  normalizeDefinition,
  retargetScope,
} from '../../../../src/services/schema-compare/retarget';

const pgQuote = (name: string): string => postgresDialect.quoteIdentifier(name);

describe('retargetScope', () => {
  it('puts the target schema in place of the source qualifier', () => {
    expect(
      retargetScope(
        'CREATE VIEW public.v AS SELECT * FROM public.orders o JOIN "public"."items" i ON true',
        'public',
        'staging',
        'postgres',
        pgQuote,
      ),
    ).toBe(
      'CREATE VIEW staging.v AS SELECT * FROM staging.orders o JOIN "staging"."items" i ON true',
    );
  });

  it('quotes a target name that needs it', () => {
    expect(
      retargetScope('SELECT * FROM public.t', 'public', 'My Schema', 'postgres', pgQuote),
    ).toBe('SELECT * FROM "My Schema".t');
    expect(
      retargetScope('SELECT * FROM `shop`.`t`', 'shop', 'shop_copy', 'mysql', (name) =>
        mysqlDialect.quoteIdentifier(name),
      ),
    ).toBe('SELECT * FROM `shop_copy`.`t`');
  });

  it('matches unquoted names without case, quoted names exactly', () => {
    expect(
      retargetScope('SELECT PUBLIC.a, "Public".b FROM t', 'public', 's', 'postgres', pgQuote),
    ).toBe('SELECT s.a, "Public".b FROM t');
  });

  it('leaves names that are not qualifiers, strings, comments and deeper parts alone', () => {
    const sql = "SELECT public, 'public.x', db.public.t -- public.y\nFROM t";
    expect(retargetScope(sql, 'public', 's', 'postgres', pgQuote)).toBe(sql);
  });

  it('changes nothing for the same or an unknown scope', () => {
    expect(retargetScope('SELECT public.t', 'public', 'public', 'postgres', pgQuote)).toBe(
      'SELECT public.t',
    );
    expect(retargetScope('SELECT public.t', undefined, 's', 'postgres', pgQuote)).toBe(
      'SELECT public.t',
    );
  });
});

describe('normalizeDefinition', () => {
  it('ignores whitespace, trailing semicolons and comments in front', () => {
    expect(normalizeDefinition(['-- Views\nCREATE VIEW v AS\n  SELECT 1;'])).toBe(
      normalizeDefinition(['CREATE VIEW v AS SELECT 1']),
    );
  });

  it('keeps statements apart and their order', () => {
    expect(normalizeDefinition(['CREATE SEQUENCE s', 'ALTER SEQUENCE s OWNED BY t.id'])).not.toBe(
      normalizeDefinition(['ALTER SEQUENCE s OWNED BY t.id', 'CREATE SEQUENCE s']),
    );
  });
});
