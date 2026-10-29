import { describe, expect, it } from 'vitest';
import {
  clickhouseColumnSql,
  clickhouseDdl,
  storedType,
} from '../../../../src/drivers/clickhouse/ddl';
import {
  type ColumnDesign,
  NO_BACKGROUND,
  type TableDesign,
} from '../../../../src/shared/table-design';

function column(id: string, name: string, overrides: Partial<ColumnDesign> = {}): ColumnDesign {
  return {
    id,
    original: name,
    name,
    type: 'String',
    length: '',
    nullable: false,
    defaultValue: '',
    autoIncrement: false,
    primaryKey: false,
    comment: '',
    ...overrides,
  };
}

const TABLE = { database: 'shop', name: 'people' };

const ID = column('c1', 'id', { type: 'UInt64', primaryKey: true });
const EMAIL = column('c2', 'email');
const SCORE = column('c3', 'score', { type: 'Decimal', length: '6,2', nullable: true });

const people: TableDesign = {
  name: 'people',
  comment: '',
  columns: [ID, EMAIL, SCORE],
  indexes: [],
  foreignKeys: [],
};

describe('storedType', () => {
  it('wraps a nullable column in Nullable', () => {
    expect(storedType(column('a', 'a', { nullable: true }))).toBe('Nullable(String)');
    expect(storedType(column('a', 'a', { type: 'Decimal', length: '6,2', nullable: true }))).toBe(
      'Nullable(Decimal(6,2))',
    );
  });

  it('puts Nullable inside LowCardinality', () => {
    expect(storedType(column('a', 'a', { type: 'LowCardinality(String)', nullable: true }))).toBe(
      'LowCardinality(Nullable(String))',
    );
  });

  it('leaves keys, composite types and already nullable types alone', () => {
    expect(storedType(column('a', 'a', { nullable: true, primaryKey: true }))).toBe('String');
    expect(storedType(column('a', 'a', { type: 'Array(Int32)', nullable: true }))).toBe(
      'Array(Int32)',
    );
    expect(storedType(column('a', 'a', { type: 'Map(String, String)', nullable: true }))).toBe(
      'Map(String, String)',
    );
    expect(storedType(column('a', 'a', { type: 'Nullable(Int8)', nullable: true }))).toBe(
      'Nullable(Int8)',
    );
    expect(storedType(column('a', 'a'))).toBe('String');
  });
});

describe('clickhouseColumnSql', () => {
  it('writes the name, the stored type, the default and the comment', () => {
    expect(
      clickhouseColumnSql(
        column('a', 'joined', { type: 'DateTime', defaultValue: ' now() ', comment: "it's" }),
      ),
    ).toBe("`joined` DateTime DEFAULT now() COMMENT 'it\\'s'");
    expect(clickhouseColumnSql(column('a', ' note ', { nullable: true }))).toBe(
      '`note` Nullable(String)',
    );
  });
});

describe('clickhouseDdl', () => {
  it('offers what ClickHouse has and nothing else', () => {
    expect(clickhouseDdl.designer).toMatchObject({
      columnComments: true,
      tableComment: true,
      reorder: true,
      autoIncrement: false,
      foreignKeys: false,
      uniqueIndexes: false,
    });
    expect(clickhouseDdl.designer.types).toContain('LowCardinality(String)');
    expect(clickhouseDdl.createSchema).toBeUndefined();
    expect(clickhouseDdl.createDatabase?.('a`b')).toBe('CREATE DATABASE `a\\`b`');
    expect(clickhouseDdl.dropDatabase?.('shop')).toBe('DROP DATABASE `shop`');
  });

  it('creates a MergeTree table ordered by the key, with skipping indexes and a comment', () => {
    const design: TableDesign = {
      ...people,
      comment: 'People',
      indexes: [
        { id: 'i1', name: 'ix_email', columns: ['c2'], unique: false },
        { id: 'i2', name: 'ix_pair', columns: ['c2', 'c3'], unique: false },
        { id: 'i3', name: 'ux_email', columns: ['c2'], unique: true },
      ],
      foreignKeys: [
        {
          id: 'f1',
          name: 'fk',
          columns: ['c1'],
          targetTable: 'other',
          targetColumns: ['id'],
          onDelete: 'CASCADE',
          onUpdate: 'NO ACTION',
        },
      ],
    };
    expect(clickhouseDdl.createTable({ database: 'shop', name: '' }, design)).toEqual([
      [
        'CREATE TABLE `shop`.`people` (',
        '  `id` UInt64,',
        '  `email` String,',
        '  `score` Nullable(Decimal(6,2)),',
        '  INDEX `ix_email` `email` TYPE bloom_filter GRANULARITY 4,',
        '  INDEX `ix_pair` (`email`, `score`) TYPE bloom_filter GRANULARITY 4',
        ')',
        'ENGINE = MergeTree',
        'ORDER BY (`id`)',
        "COMMENT 'People'",
      ].join('\n'),
    ]);
  });

  it('orders a table without a key by nothing', () => {
    const design = { ...people, columns: people.columns.map((c) => ({ ...c, primaryKey: false })) };
    expect(clickhouseDdl.createTable({ name: '' }, design)[0]).toMatch(/ORDER BY tuple\(\)$/u);
  });

  it('renames, truncates and drops relations', () => {
    expect(clickhouseDdl.renameRelation(TABLE, 'table', 'folk')).toBe(
      'RENAME TABLE `shop`.`people` TO `shop`.`folk`',
    );
    expect(clickhouseDdl.truncateTable(TABLE)).toBe('TRUNCATE TABLE `shop`.`people`');
    expect(clickhouseDdl.dropRelation(TABLE, 'table')).toBe('DROP TABLE `shop`.`people`');
    expect(clickhouseDdl.dropRelation(TABLE, 'view')).toBe('DROP VIEW `shop`.`people`');
    expect(clickhouseDdl.dropRelation(TABLE, 'materialized-view')).toBe(
      'DROP VIEW `shop`.`people`',
    );
  });

  it('drops tables, views and server-wide functions, and refuses the rest', () => {
    expect(clickhouseDdl.dropObject({ kind: 'view', ...TABLE })).toBe('DROP VIEW `shop`.`people`');
    expect(clickhouseDdl.dropObject({ kind: 'table', ...TABLE })).toBe(
      'DROP TABLE `shop`.`people`',
    );
    expect(clickhouseDdl.dropObject({ kind: 'function', database: 'shop', name: 'f' })).toBe(
      'DROP FUNCTION `f`',
    );
    for (const kind of ['procedure', 'trigger', 'sequence', 'event'] as const) {
      expect(() => clickhouseDdl.dropObject({ kind, name: 'x' })).toThrow(/no /u);
    }
  });

  describe('replaceObject', () => {
    it('replaces a plain view in place with OR REPLACE', () => {
      const plan = clickhouseDdl.replaceObject(
        { kind: 'view', ...TABLE },
        ['  create view people AS SELECT 2', 'CREATE OR REPLACE VIEW x AS SELECT 1'],
        ['CREATE VIEW people AS SELECT 1'],
      );
      expect(plan).toEqual({
        check: [],
        statements: [
          '  CREATE OR REPLACE VIEW people AS SELECT 2',
          'CREATE OR REPLACE VIEW x AS SELECT 1',
        ],
        recovery: [],
      });
    });

    it('drops and makes a materialized view again, making the old one when that fails', () => {
      const plan = clickhouseDdl.replaceObject(
        { kind: 'view', materialized: true, ...TABLE },
        ['CREATE MATERIALIZED VIEW people AS SELECT 2'],
        ['CREATE MATERIALIZED VIEW people AS SELECT 1'],
      );
      expect(plan).toEqual({
        check: [],
        statements: [
          'DROP VIEW IF EXISTS `shop`.`people`',
          'CREATE MATERIALIZED VIEW people AS SELECT 2',
        ],
        recovery: ['CREATE MATERIALIZED VIEW people AS SELECT 1'],
      });
    });

    it('edits nothing but views', () => {
      expect(() => clickhouseDdl.replaceObject({ kind: 'table', ...TABLE }, [], [])).toThrow(
        /not edited/u,
      );
    });
  });
});

describe('clickhouseDdl.alterTable', () => {
  const alter = (after: TableDesign, before: TableDesign = people) =>
    clickhouseDdl.alterTable(TABLE, before, after, NO_BACKGROUND);

  it('changes nothing for the same design', () => {
    expect(alter(people)).toEqual({ statements: [], notes: [], recovery: [] });
  });

  it('renames, retypes, changes defaults and comments column by column, without a transaction', () => {
    const after: TableDesign = {
      ...people,
      columns: [
        ID,
        column('c2', 'mail', { original: 'email', defaultValue: "'x'", comment: 'Login' }),
        column('c3', 'score', { type: 'Decimal', length: '8,3', nullable: false }),
      ],
    };
    const plan = alter(after);
    expect(plan.statements).toEqual([
      'ALTER TABLE `shop`.`people` RENAME COLUMN `email` TO `mail`',
      "ALTER TABLE `shop`.`people` MODIFY COLUMN `mail` DEFAULT 'x'",
      "ALTER TABLE `shop`.`people` COMMENT COLUMN `mail` 'Login'",
      'ALTER TABLE `shop`.`people` MODIFY COLUMN `score` Decimal(8,3)',
    ]);
    expect(plan.recovery).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  it('removes a default and makes a column nullable', () => {
    const before = {
      ...people,
      columns: people.columns.map((c) => (c.name === 'email' ? { ...c, defaultValue: "''" } : c)),
    };
    const after = {
      ...people,
      columns: people.columns.map((c) => (c.name === 'email' ? { ...c, nullable: true } : c)),
    };
    expect(alter(after, before).statements).toEqual([
      'ALTER TABLE `shop`.`people` MODIFY COLUMN `email` Nullable(String)',
      'ALTER TABLE `shop`.`people` MODIFY COLUMN `email` REMOVE DEFAULT',
    ]);
  });

  it('adds columns where they stand and drops others', () => {
    const after: TableDesign = {
      ...people,
      columns: [
        { ...column('n1', 'first'), original: undefined },
        ID,
        { ...column('n2', 'nick', { nullable: true, comment: 'Nickname' }), original: undefined },
        SCORE,
      ],
    };
    const statements = alter(after).statements;
    expect(statements).toContain('ALTER TABLE `shop`.`people` DROP COLUMN `email`');
    expect(statements).toContain('ALTER TABLE `shop`.`people` ADD COLUMN `first` String FIRST');
    expect(statements).toContain(
      "ALTER TABLE `shop`.`people` ADD COLUMN `nick` Nullable(String) COMMENT 'Nickname' AFTER `id`",
    );
  });

  it('moves kept columns with their type, FIRST or AFTER the one before', () => {
    const after: TableDesign = {
      ...people,
      columns: [SCORE, ID, EMAIL],
    };
    expect(alter(after).statements).toEqual([
      'ALTER TABLE `shop`.`people` MODIFY COLUMN `score` Nullable(Decimal(6,2)) FIRST',
      'ALTER TABLE `shop`.`people` MODIFY COLUMN `id` UInt64 AFTER `score`',
      'ALTER TABLE `shop`.`people` MODIFY COLUMN `email` String AFTER `id`',
    ]);
  });

  it('adds and drops skipping indexes, but leaves fixed ones and unique ones out', () => {
    const before: TableDesign = {
      ...people,
      indexes: [
        { id: 'i1', original: 'ix_old', name: 'ix_old', columns: ['c2'], unique: false },
        { id: 'i2', original: 'ix_fixed', name: 'ix_fixed', columns: ['c3'], unique: false },
      ],
    };
    const after: TableDesign = {
      ...people,
      indexes: [
        { id: 'i3', name: 'ix_new', columns: ['c2'], unique: false },
        { id: 'i4', name: 'ux_new', columns: ['c2'], unique: true },
      ],
    };
    const plan = clickhouseDdl.alterTable(TABLE, before, after, {
      ...NO_BACKGROUND,
      fixedIndexes: [{ name: 'ix_fixed', description: 'minmax' }],
    });
    expect(plan.statements).toEqual([
      'ALTER TABLE `shop`.`people` DROP INDEX `ix_old`',
      'ALTER TABLE `shop`.`people` ADD INDEX `ix_new` `email` TYPE bloom_filter GRANULARITY 4',
    ]);
  });

  it('changes the table comment and renames the table last', () => {
    const plan = alter({ ...people, name: 'folk', comment: 'Folk' });
    expect(plan.statements).toEqual([
      "ALTER TABLE `shop`.`people` MODIFY COMMENT 'Folk'",
      'RENAME TABLE `shop`.`people` TO `shop`.`folk`',
    ]);
  });

  it('refuses to change the sorting key', () => {
    const after = {
      ...people,
      columns: people.columns.map((c) => ({ ...c, primaryKey: c.name === 'email' })),
    };
    expect(() => alter(after)).toThrow(/sorting key/u);
  });
});
