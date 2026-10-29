import { describe, expect, it } from 'vitest';
import {
  CURRENT_POSTGRES,
  forServer,
  generatedColumnSql,
  pgServer,
  printsTriggers,
  withoutDatabase,
} from '../../../../src/drivers/postgres/server';

describe('pgServer', () => {
  it('tells CockroachDB, YugabyteDB and PostgreSQL apart by version()', () => {
    expect(
      pgServer('CockroachDB CCL v24.3.6 (x86_64-pc-linux-gnu, built 2025/02/19)', '130000'),
    ).toEqual({ flavor: 'cockroach', version: 130_000 });
    expect(pgServer('PostgreSQL 11.2-YB-2024.2.2.1-b0 on x86_64-pc-linux-gnu', '110002')).toEqual({
      flavor: 'yugabyte',
      version: 110_002,
    });
    expect(pgServer('PostgreSQL 17.2 on x86_64-pc-linux-musl', '170002')).toEqual({
      flavor: 'postgres',
      version: 170_002,
    });
  });

  it('takes a current PostgreSQL when the number says nothing', () => {
    expect(pgServer('', '')).toEqual(CURRENT_POSTGRES);
    expect(pgServer('PostgreSQL 99', 'abc').version).toBe(CURRENT_POSTGRES.version);
  });
});

describe('catalog variants', () => {
  it('reads generated columns from PostgreSQL 12 on, and none before', () => {
    expect(generatedColumnSql()).toBe('a.attgenerated::text');
    expect(generatedColumnSql({ flavor: 'postgres', version: 120_000 })).toBe(
      'a.attgenerated::text',
    );
    expect(generatedColumnSql({ flavor: 'yugabyte', version: 110_002 })).toBe("''::text");
  });

  it('prints triggers everywhere but in CockroachDB', () => {
    expect(printsTriggers()).toBe(true);
    expect(printsTriggers({ flavor: 'yugabyte', version: 110_002 })).toBe(true);
    expect(printsTriggers({ flavor: 'cockroach', version: 130_000 })).toBe(false);
  });
});

describe('withoutDatabase', () => {
  it('drops the database in front of schema-qualified names', () => {
    expect(
      withoutDatabase(
        'SELECT o.id FROM shop.public.orders AS o JOIN "shop".public.items AS i ON true',
        'shop',
      ),
    ).toBe('SELECT o.id FROM public.orders AS o JOIN public.items AS i ON true');
  });

  it('keeps strings, comments, other databases, and columns that happen to share the name', () => {
    const sql = "SELECT 'shop.public.x', t.shop, other.public.y -- shop.public.z\nFROM public.t";
    expect(withoutDatabase(sql, 'shop')).toBe(sql);
  });

  it('matches a quoted database exactly', () => {
    expect(withoutDatabase('SELECT * FROM "My Shop".public.t', 'My Shop')).toBe(
      'SELECT * FROM public.t',
    );
    expect(withoutDatabase('SELECT * FROM "My Shop".public.t', 'my shop')).toBe(
      'SELECT * FROM "My Shop".public.t',
    );
  });
});

describe('forServer', () => {
  const cockroach = { flavor: 'cockroach', version: 130_000 } as const;
  const insert = 'INSERT INTO "public"."t" ("id", "a)b") OVERRIDING SYSTEM VALUE VALUES (1, \'x\')';

  it('leaves out OVERRIDING SYSTEM VALUE in CockroachDB, which has no such clause', () => {
    expect(forServer(insert, cockroach)).toBe(
      'INSERT INTO "public"."t" ("id", "a)b") VALUES (1, \'x\')',
    );
    expect(forServer('insert into t (id) overriding system value select 1', cockroach)).toBe(
      'insert into t (id) select 1',
    );
  });

  it('sends everything else as written, and everything to PostgreSQL', () => {
    expect(forServer(insert)).toBe(insert);
    expect(forServer(insert, { flavor: 'yugabyte', version: 110_002 })).toBe(insert);
    const text = "SELECT 'OVERRIDING SYSTEM VALUE VALUES'";
    expect(forServer(text, cockroach)).toBe(text);
    const user = 'INSERT INTO t (id) OVERRIDING USER VALUE VALUES (1)';
    expect(forServer(user, cockroach)).toBe(user);
  });
});
