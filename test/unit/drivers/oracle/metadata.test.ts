import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { OracleMetadata, TYPE_TEXT } from '../../../../src/drivers/oracle/metadata';

type Binds = Record<string, string> | undefined;
type Answer = readonly unknown[][] | Error | undefined;

interface Asked {
  readonly sql: string;
  readonly binds: Binds;
}

/** A metadata reader over a dictionary that answers each query through `answer`. */
function metadata(answer: (sql: string, binds: Binds) => Answer) {
  const asked: Asked[] = [];
  const reader = new OracleMetadata((sql, binds) => {
    asked.push({ sql, binds });
    const rows = answer(sql, binds);
    return rows instanceof Error ? Promise.reject(rows) : Promise.resolve([...(rows ?? [])]);
  }, 'FREEPDB1');
  return { reader, asked };
}

/** Answers by the first phrase the query contains. */
function byPhrase(answers: Record<string, readonly unknown[][]>) {
  return metadata((sql) => {
    const key = Object.keys(answers).find((phrase) => sql.includes(phrase));
    return key === undefined ? [] : answers[key];
  });
}

const customers = { schema: 'DATANEST', name: 'CUSTOMERS' };

const COLUMNS = [
  ['ID', 'NUMBER(10)', 'N', '"DATANEST"."ISEQ$$_7".nextval', 'YES', 'NO', null, 1],
  ['NAME', 'VARCHAR2(100 CHAR)', 'Y', "'anon' ", 'NO', 'NO', 'Who', 0],
  ['TOTAL', 'NUMBER', 'Y', 'PRICE * QTY', 'NO', 'YES', null, '0'],
  ['NOTE', 'CLOB', 'Y', null, 'NO', 'NO', '  ', 0],
  ['CODE', 'CHAR(2 BYTE)', 'N', '   ', 'NO', 'NO', null, '1'],
  ['GONE', 'DATE', 'Y', ' null\n', 'NO', 'NO', null, 0],
  ['KEPT', 'VARCHAR2(4 BYTE)', 'Y', "'NULL'", 'NO', 'NO', null, 0],
];

const INDEX_ROWS = [
  ['PK_CUSTOMERS', 'UNIQUE', 1, 0, 'NORMAL', 'ID'],
  ['PK_CUSTOMERS', 'UNIQUE', 1, 0, 'NORMAL', 'CODE'],
  ['UX_NAME', 'UNIQUE', 0, 1, 'NORMAL', 'NAME'],
  ['IX_UPPER', 'NONUNIQUE', 0, 0, 'FUNCTION-BASED NORMAL', null],
  ['IX_STATE', 'NONUNIQUE', '0', '0', 'BITMAP', 'CODE'],
];

const FK_ROWS = [
  ['FK_REGION', 'CODE', 'GEO', 'REGIONS', 'ID', 'CASCADE'],
  ['FK_PAIR', 'ID', 'DATANEST', 'PAIRS', 'A', 'NO ACTION'],
  ['FK_PAIR', 'CODE', 'DATANEST', 'PAIRS', 'B', 'NO ACTION'],
];

describe('TYPE_TEXT', () => {
  it('spells character, number, float and raw types the way DDL writes them', () => {
    expect(TYPE_TEXT).toContain("THEN ' CHAR' ELSE ' BYTE' END");
    expect(TYPE_TEXT).toContain("WHEN c.data_type = 'NUMBER' AND c.data_scale = 0 THEN 'INTEGER'");
    expect(TYPE_TEXT).toContain("'FLOAT(' || c.data_precision || ')'");
    expect(TYPE_TEXT).toContain("'RAW(' || c.data_length || ')'");
  });
});

describe('OracleMetadata databases and schemas', () => {
  it('lists the service of the connection as its one database, without a query', async () => {
    const { reader, asked } = byPhrase({});
    expect(await reader.listDatabases()).toEqual(['FREEPDB1']);
    expect(asked).toEqual([]);
  });

  it('lists schemas without blank names, the session user first', async () => {
    const { reader, asked } = byPhrase({ 'FROM all_users': [['DATANEST'], ['HR'], [null], ['']] });
    expect(await reader.listSchemas()).toEqual(['DATANEST', 'HR']);
    expect(asked[0]?.sql).toContain("oracle_maintained = 'N'");
    expect(asked[0]?.sql).toMatch(/ORDER BY CASE WHEN username = SYS_CONTEXT/u);
  });

  it('has no types to dump', async () => {
    expect(await byPhrase({}).reader.listTypeDumps()).toEqual([]);
  });
});

describe('OracleMetadata.listTables', () => {
  it('lists tables, views and materialized views of a schema', async () => {
    const { reader, asked } = byPhrase({
      "'MVIEW'": [
        ['CUSTOMERS', 'TABLE'],
        ['MV_TOTALS', 'MVIEW'],
        ['V_ACTIVE', 'VIEW'],
      ],
    });
    expect(await reader.listTables({ schema: 'DATANEST' })).toEqual([
      { name: 'CUSTOMERS', kind: 'table' },
      { name: 'MV_TOTALS', kind: 'view', materialized: true },
      { name: 'V_ACTIVE', kind: 'view' },
    ]);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.binds).toEqual({ owner: 'DATANEST' });
    // The tables that hold a materialized view's rows are left out.
    expect(asked[0]?.sql).toContain('m.container_name = t.table_name');
  });

  it('asks for the current schema with an empty owner when the scope has none', async () => {
    const { reader, asked } = byPhrase({});
    expect(await reader.listTables({})).toEqual([]);
    expect(asked[0]?.binds).toEqual({ owner: '' });
    expect(asked[0]?.sql).toContain("NVL(:owner, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))");
  });
});

describe('OracleMetadata.listColumns', () => {
  it('reads columns with their types, nullability, key flag and defaults', async () => {
    const { reader, asked } = byPhrase({ 'FROM all_tab_cols c': COLUMNS });
    expect(await reader.listColumns(customers)).toEqual([
      { name: 'ID', dataType: 'NUMBER(10)', nullable: false, primaryKey: true },
      {
        name: 'NAME',
        dataType: 'VARCHAR2(100 CHAR)',
        nullable: true,
        primaryKey: false,
        defaultValue: "'anon'",
      },
      { name: 'TOTAL', dataType: 'NUMBER', nullable: true, primaryKey: false },
      { name: 'NOTE', dataType: 'CLOB', nullable: true, primaryKey: false },
      { name: 'CODE', dataType: 'CHAR(2 BYTE)', nullable: false, primaryKey: true },
      { name: 'GONE', dataType: 'DATE', nullable: true, primaryKey: false },
      {
        name: 'KEPT',
        dataType: 'VARCHAR2(4 BYTE)',
        nullable: true,
        primaryKey: false,
        defaultValue: "'NULL'",
      },
    ]);
    expect(asked[0]?.binds).toEqual({ owner: 'DATANEST', name: 'CUSTOMERS' });
    expect(asked[0]?.sql).toContain("c.hidden_column = 'NO'");
    expect(asked[0]?.sql).toContain('ORDER BY c.column_id');
  });

  it('reads a default stored as the text NULL, in any case, as no default', async () => {
    const { reader } = byPhrase({
      'FROM all_tab_cols c': [
        ['A', 'DATE', 'Y', 'NULL', 'NO', 'NO', null, 0],
        ['B', 'DATE', 'Y', 'Null ', 'NO', 'NO', null, 0],
        ['C', 'DATE', 'Y', 'NULLIF(1, 1)', 'NO', 'NO', null, 0],
      ],
    });
    expect((await reader.listColumns(customers)).map((c) => c.defaultValue)).toEqual([
      undefined,
      undefined,
      'NULLIF(1, 1)',
    ]);
  });

  it('gives identity and virtual columns no default', async () => {
    const { reader } = byPhrase({ 'FROM all_tab_cols c': COLUMNS });
    const columns = await reader.listColumns(customers);
    expect(columns[0]).not.toHaveProperty('defaultValue');
    expect(columns[2]).not.toHaveProperty('defaultValue');
  });

  it('binds an empty owner for a table without a schema', async () => {
    const { reader, asked } = byPhrase({});
    await reader.listColumns({ name: 'CUSTOMERS' });
    expect(asked[0]?.binds).toEqual({ owner: '', name: 'CUSTOMERS' });
  });
});

describe('OracleMetadata keys and indexes', () => {
  it('groups unique keys by index, leaving out function-based ones', async () => {
    const { reader, asked } = byPhrase({
      "i.uniqueness = 'UNIQUE'": [
        ['UX_EMAIL', 'EMAIL'],
        ['UX_PAIR', 'A'],
        ['UX_PAIR', 'B'],
        ['UX_FN', null],
        [null, 'X'],
      ],
    });
    expect(await reader.listUniqueKeys(customers)).toEqual([['EMAIL'], ['A', 'B']]);
    expect(asked[0]?.binds).toEqual({ owner: 'DATANEST', name: 'CUSTOMERS' });
    // The primary key is not one of them.
    expect(asked[0]?.sql).toContain("k.constraint_type = 'P'");
  });

  it('groups foreign keys with their target schema and delete rule', async () => {
    const { reader, asked } = byPhrase({ "k.constraint_type = 'R'": FK_ROWS });
    expect(await reader.listForeignKeys(customers)).toEqual([
      {
        name: 'FK_REGION',
        columns: ['CODE'],
        targetColumns: ['ID'],
        target: { schema: 'GEO', name: 'REGIONS' },
        onDelete: 'CASCADE',
        onUpdate: 'NO ACTION',
      },
      {
        name: 'FK_PAIR',
        columns: ['ID', 'CODE'],
        targetColumns: ['A', 'B'],
        target: { schema: 'DATANEST', name: 'PAIRS' },
        onDelete: 'NO ACTION',
        onUpdate: 'NO ACTION',
      },
    ]);
    expect(asked[0]?.binds).toEqual({ owner: 'DATANEST', name: 'CUSTOMERS' });
  });

  it('leaves the delete rule out when the dictionary gives none, and drops broken keys', async () => {
    const { reader } = byPhrase({
      "k.constraint_type = 'R'": [
        ['FK_A', 'X', 'DATANEST', 'T', 'ID', null],
        ['FK_B', 'Y', 'DATANEST', null, 'ID', 'CASCADE'],
      ],
    });
    expect(await reader.listForeignKeys(customers)).toEqual([
      {
        name: 'FK_A',
        columns: ['X'],
        targetColumns: ['ID'],
        target: { schema: 'DATANEST', name: 'T' },
        onUpdate: 'NO ACTION',
      },
    ]);
  });

  it('groups indexes, keeping the kind of all but plain B-trees', async () => {
    const { reader, asked } = byPhrase({ "i.index_type <> 'LOB'": INDEX_ROWS });
    expect(await reader.listIndexes(customers)).toEqual([
      { name: 'PK_CUSTOMERS', columns: ['ID', 'CODE'], unique: true, primary: true },
      { name: 'UX_NAME', columns: ['NAME'], unique: true, primary: false, constraint: true },
      {
        name: 'IX_UPPER',
        columns: ['(expression)'],
        unique: false,
        primary: false,
        method: 'FUNCTION-BASED NORMAL',
      },
      { name: 'IX_STATE', columns: ['CODE'], unique: false, primary: false, method: 'BITMAP' },
    ]);
    expect(asked[0]?.binds).toEqual({ owner: 'DATANEST', name: 'CUSTOMERS' });
  });
});

describe('OracleMetadata.listObjects', () => {
  it('lists functions and procedures by their object type', async () => {
    const { reader, asked } = byPhrase({ 'FROM all_objects': [['F_ONE'], ['F_TWO']] });
    expect(await reader.listObjects({ schema: 'DATANEST' }, 'function')).toEqual([
      { name: 'F_ONE', kind: 'function' },
      { name: 'F_TWO', kind: 'function' },
    ]);
    expect(asked[0]?.binds).toEqual({ owner: 'DATANEST', type: 'FUNCTION' });
    await reader.listObjects({}, 'procedure');
    expect(asked[1]?.binds).toEqual({ owner: '', type: 'PROCEDURE' });
  });

  it('lists triggers of tables with their table', async () => {
    const { reader, asked } = byPhrase({ 'FROM all_triggers': [['TR_AUDIT', 'CUSTOMERS']] });
    expect(await reader.listObjects({ schema: 'DATANEST' }, 'trigger')).toEqual([
      { name: 'TR_AUDIT', kind: 'trigger', table: 'CUSTOMERS' },
    ]);
    expect(asked[0]?.sql).toContain("base_object_type = 'TABLE'");
    expect(asked[0]?.binds).toEqual({ owner: 'DATANEST' });
  });

  it('lists sequences, leaving out those of identity columns', async () => {
    const { reader, asked } = byPhrase({ 'FROM all_sequences': [['ORDER_SEQ']] });
    expect(await reader.listObjects({ schema: 'DATANEST' }, 'sequence')).toEqual([
      { name: 'ORDER_SEQ', kind: 'sequence' },
    ]);
    expect(asked[0]?.sql).toContain("NOT LIKE 'ISEQ$$\\_%' ESCAPE '\\'");
  });

  it('lists no events, without asking', async () => {
    const { reader, asked } = byPhrase({});
    expect(await reader.listObjects({ schema: 'DATANEST' }, 'event')).toEqual([]);
    expect(asked).toEqual([]);
  });
});

describe('OracleMetadata.describeTable', () => {
  const dictionary = {
    all_tab_comments: [['CUSTOMERS', 'People', 'PK_CUSTOMERS']],
    'FROM all_tab_cols c': COLUMNS,
    "i.index_type <> 'LOB'": INDEX_ROWS,
    "k.constraint_type = 'R'": FK_ROWS,
  };

  it('describes columns, keys, indexes, the comment and the key name', async () => {
    const { reader } = byPhrase(dictionary);
    const structure = await reader.describeTable(customers);
    expect(structure.columns).toEqual([
      {
        name: 'ID',
        dataType: 'NUMBER(10)',
        nullable: false,
        autoIncrement: true,
        generated: false,
      },
      {
        name: 'NAME',
        dataType: 'VARCHAR2(100 CHAR)',
        nullable: true,
        autoIncrement: false,
        generated: false,
        defaultExpression: "'anon'",
        comment: 'Who',
      },
      { name: 'TOTAL', dataType: 'NUMBER', nullable: true, autoIncrement: false, generated: true },
      { name: 'NOTE', dataType: 'CLOB', nullable: true, autoIncrement: false, generated: false },
      {
        name: 'CODE',
        dataType: 'CHAR(2 BYTE)',
        nullable: false,
        autoIncrement: false,
        generated: false,
      },
      { name: 'GONE', dataType: 'DATE', nullable: true, autoIncrement: false, generated: false },
      {
        name: 'KEPT',
        dataType: 'VARCHAR2(4 BYTE)',
        nullable: true,
        autoIncrement: false,
        generated: false,
        defaultExpression: "'NULL'",
      },
    ]);
    expect(structure.primaryKey).toEqual(['ID', 'CODE']);
    expect(structure.indexes.map((index) => index.name)).toEqual([
      'PK_CUSTOMERS',
      'UX_NAME',
      'IX_UPPER',
      'IX_STATE',
    ]);
    expect(structure.foreignKeys.map((key) => key.name)).toEqual(['FK_REGION', 'FK_PAIR']);
    expect(structure.comment).toBe('People');
    expect(structure.primaryKeyName).toBe('PK_CUSTOMERS');
  });

  it('lists the checks of the table, without the NOT NULL of its columns', async () => {
    const { reader, asked } = byPhrase({
      ...dictionary,
      "constraint_type = 'C'": [
        ['SYS_C0011', '"ID" IS NOT NULL'],
        ['CK_TOTAL', 'TOTAL > 0'],
      ],
    });
    const structure = await reader.describeTable(customers);
    expect(structure.checks).toEqual([{ name: 'CK_TOTAL', expression: '(TOTAL > 0)' }]);
    expect(asked.some((call) => call.sql.includes("constraint_type = 'C'"))).toBe(true);
  });

  it('has no checks when the dictionary lists none', async () => {
    const { reader } = byPhrase(dictionary);
    expect((await reader.describeTable(customers)).checks).toEqual([]);
  });

  it('leaves out a missing comment, key name and primary key', async () => {
    const { reader } = byPhrase({
      ...dictionary,
      all_tab_comments: [['CUSTOMERS', null, null]],
      "i.index_type <> 'LOB'": [],
    });
    const structure = await reader.describeTable(customers);
    expect(structure).not.toHaveProperty('comment');
    expect(structure).not.toHaveProperty('primaryKeyName');
    expect(structure.primaryKey).toEqual([]);
  });

  it('says not-found for a table that is not there', async () => {
    const { reader, asked } = byPhrase({});
    await expect(reader.describeTable(customers)).rejects.toThrow(
      expect.objectContaining({
        code: 'not-found',
        message: expect.stringContaining('CUSTOMERS') as unknown,
      }),
    );
    expect(asked).toHaveLength(1);
    expect(asked[0]?.binds).toEqual({ owner: 'DATANEST', name: 'CUSTOMERS' });
  });
});

describe('OracleMetadata.getDefinition', () => {
  /** A dictionary where GET_DDL answers by the type it is asked for. */
  function withDdl(ddl: Record<string, string | null>) {
    return metadata((sql, binds) => {
      if (sql.includes('DBMS_METADATA.GET_DDL(')) {
        const text = ddl[binds?.type ?? ''];
        return text === undefined ? [] : [[text]];
      }
      return [];
    });
  }

  it('reads a view through DBMS_METADATA, after setting its transforms', async () => {
    const { reader, asked } = withDdl({
      VIEW: '\n  CREATE OR REPLACE FORCE EDITIONABLE VIEW "DATANEST"."V" ("A") AS SELECT 1 FROM dual;',
    });
    expect(await reader.getDefinition({ kind: 'view', schema: 'DATANEST', name: 'V' })).toEqual([
      'CREATE OR REPLACE FORCE EDITIONABLE VIEW "DATANEST"."V" ("A") AS SELECT 1 FROM dual',
    ]);
    expect(asked).toHaveLength(2);
    expect(asked[0]?.sql).toMatch(/^BEGIN\n/u);
    expect(asked[0]?.sql).toContain("'SEGMENT_ATTRIBUTES', FALSE");
    expect(asked[0]?.sql).toContain("'SQLTERMINATOR', TRUE");
    expect(asked[0]?.sql).toContain("'REF_CONSTRAINTS', TRUE");
    expect(asked[1]?.binds).toEqual({ type: 'VIEW', name: 'V', owner: 'DATANEST' });
  });

  it('reads a materialized view as MATERIALIZED_VIEW', async () => {
    const { reader, asked } = withDdl({
      MATERIALIZED_VIEW: 'CREATE MATERIALIZED VIEW "M" AS SELECT 1 FROM dual;',
    });
    expect(await reader.getDefinition({ kind: 'view', name: 'M', materialized: true })).toEqual([
      'CREATE MATERIALIZED VIEW "M" AS SELECT 1 FROM dual',
    ]);
    expect(asked[1]?.binds).toEqual({ type: 'MATERIALIZED_VIEW', name: 'M', owner: '' });
  });

  it('splits a routine or trigger into its statements', async () => {
    const { reader, asked } = withDdl({
      TRIGGER:
        '\n  CREATE OR REPLACE EDITIONABLE TRIGGER "DATANEST"."TR" BEFORE INSERT ON "DATANEST"."CUSTOMERS"\nBEGIN\n  NULL;\nEND;\n/\nALTER TRIGGER "DATANEST"."TR" ENABLE;',
    });
    expect(
      await reader.getDefinition({
        kind: 'trigger',
        schema: 'DATANEST',
        name: 'TR',
        table: 'CUSTOMERS',
      }),
    ).toEqual([
      'CREATE OR REPLACE EDITIONABLE TRIGGER "DATANEST"."TR" BEFORE INSERT ON "DATANEST"."CUSTOMERS"\nBEGIN\n  NULL;\nEND;',
      'ALTER TRIGGER "DATANEST"."TR" ENABLE',
    ]);
    expect(asked[1]?.binds?.type).toBe('TRIGGER');
  });

  it.each([
    [
      'function',
      'FUNCTION',
      '\n  CREATE OR REPLACE EDITIONABLE FUNCTION "DATANEST"."X" RETURN NUMBER IS\nBEGIN\n  RETURN 1;\nEND;\n/',
      'CREATE OR REPLACE EDITIONABLE FUNCTION "DATANEST"."X" RETURN NUMBER IS\nBEGIN\n  RETURN 1;\nEND;',
    ],
    [
      'procedure',
      'PROCEDURE',
      '\n  CREATE OR REPLACE EDITIONABLE PROCEDURE "DATANEST"."X" IS\nBEGIN\n  NULL;\nEND;\n/',
      'CREATE OR REPLACE EDITIONABLE PROCEDURE "DATANEST"."X" IS\nBEGIN\n  NULL;\nEND;',
    ],
    [
      'sequence',
      'SEQUENCE',
      '\n   CREATE SEQUENCE  "DATANEST"."X"  MINVALUE 1 START WITH 1 ;',
      'CREATE SEQUENCE  "DATANEST"."X"  MINVALUE 1 START WITH 1',
    ],
  ] as const)('asks DBMS_METADATA for a %s as %s', async (kind, type, ddl, statement) => {
    const { reader, asked } = withDdl({ [type]: ddl });
    expect(await reader.getDefinition({ kind, schema: 'DATANEST', name: 'X' })).toEqual([
      statement,
    ]);
    expect(asked[1]?.binds).toEqual({ type, name: 'X', owner: 'DATANEST' });
  });

  it('says not-found when DBMS_METADATA gives no text', async () => {
    const answers: Record<string, string | null>[] = [{ VIEW: '   ' }, { VIEW: null }, {}];
    for (const ddl of answers) {
      const { reader } = withDdl(ddl);
      await expect(reader.getDefinition({ kind: 'view', name: 'V' })).rejects.toThrow(
        expect.objectContaining({ code: 'not-found' }),
      );
    }
  });

  it('refuses events without asking', async () => {
    const { reader, asked } = withDdl({});
    await expect(reader.getDefinition({ kind: 'event', name: 'E' })).rejects.toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
    expect(asked).toEqual([]);
  });
});

describe('OracleMetadata table definitions and dumps', () => {
  const TABLE_DDL =
    '\n  CREATE TABLE "DATANEST"."CUSTOMERS" (\n "ID" NUMBER,\n CONSTRAINT "PK_CUSTOMERS" PRIMARY KEY ("ID")\n  ) ;';
  const INDEX_DDL =
    '\n  CREATE UNIQUE INDEX "DATANEST"."PK_CUSTOMERS" ON "DATANEST"."CUSTOMERS" ("ID") ;\n  CREATE INDEX "DATANEST"."IX_NAME" ON "DATANEST"."CUSTOMERS" ("NAME") ;\n  CREATE BITMAP INDEX "UX_CODE" ON "DATANEST"."CUSTOMERS" ("CODE") ;\n  CREATE UNIQUE INDEX "DATANEST"."SYS_IL0000073362C00019$$" ON "DATANEST"."CUSTOMERS";';
  const COMMENT_DDL = '\n  COMMENT ON TABLE "DATANEST"."CUSTOMERS" IS \'People\';';
  const KEY_DDL =
    '\n  ALTER TABLE "DATANEST"."CUSTOMERS" ADD CONSTRAINT "FK_REGION" FOREIGN KEY ("CODE") REFERENCES "GEO"."REGIONS" ("ID") ENABLE;';
  const TRIGGER_DDL =
    '\n  CREATE OR REPLACE EDITIONABLE TRIGGER "DATANEST"."TR"\nBEFORE INSERT ON "DATANEST"."CUSTOMERS"\nBEGIN\n  NULL;\nEND;\n/\nALTER TRIGGER "DATANEST"."TR" ENABLE;';

  const missing = () =>
    new DbError('internal', 'ORA-31608: object not found', { driverCode: 'ORA-31608' });

  function dictionary(dependent: Record<string, string | Error>) {
    return metadata((sql, binds) => {
      if (sql.includes('DBMS_METADATA.GET_DDL(')) {
        return [[TABLE_DDL]];
      }
      if (sql.includes('GET_DEPENDENT_DDL')) {
        const answer = dependent[binds?.type ?? ''];
        return answer === undefined ? missing() : answer instanceof Error ? answer : [[answer]];
      }
      if (sql.includes('FROM all_constraints')) {
        return [['PK_CUSTOMERS'], ['UX_CODE']];
      }
      if (sql.includes('FROM all_triggers')) {
        return [['TR']];
      }
      return [];
    });
  }

  const everything = {
    INDEX: INDEX_DDL,
    COMMENT: COMMENT_DDL,
    REF_CONSTRAINT: KEY_DDL,
    TRIGGER: TRIGGER_DDL,
  };

  it('dumps the table with its own indexes and comments, then keys and triggers', async () => {
    const { reader, asked } = dictionary(everything);
    expect(await reader.getTableDump(customers)).toEqual({
      before: [],
      create: [
        'CREATE TABLE "DATANEST"."CUSTOMERS" (\n "ID" NUMBER,\n CONSTRAINT "PK_CUSTOMERS" PRIMARY KEY ("ID")\n  )',
        'CREATE INDEX "DATANEST"."IX_NAME" ON "DATANEST"."CUSTOMERS" ("NAME")',
        'COMMENT ON TABLE "DATANEST"."CUSTOMERS" IS \'People\'',
      ],
      after: [
        'ALTER TABLE "DATANEST"."CUSTOMERS" ADD CONSTRAINT "FK_REGION" FOREIGN KEY ("CODE") REFERENCES "GEO"."REGIONS" ("ID") ENABLE',
        'CREATE OR REPLACE EDITIONABLE TRIGGER "DATANEST"."TR"\nBEFORE INSERT ON "DATANEST"."CUSTOMERS"\nBEGIN\n  NULL;\nEND;',
        'ALTER TRIGGER "DATANEST"."TR" ENABLE',
      ],
      owns: [{ kind: 'trigger', schema: 'DATANEST', name: 'TR', table: 'CUSTOMERS' }],
    });
    // Keys come apart from CREATE TABLE in a dump.
    expect(asked[0]?.sql).toContain("'REF_CONSTRAINTS', FALSE");
    const dependentTypes = asked
      .filter((question) => question.sql.includes('GET_DEPENDENT_DDL'))
      .map((question) => question.binds);
    expect(dependentTypes).toEqual([
      { type: 'INDEX', name: 'CUSTOMERS', owner: 'DATANEST' },
      { type: 'COMMENT', name: 'CUSTOMERS', owner: 'DATANEST' },
      { type: 'REF_CONSTRAINT', name: 'CUSTOMERS', owner: 'DATANEST' },
      { type: 'TRIGGER', name: 'CUSTOMERS', owner: 'DATANEST' },
    ]);
  });

  it('treats ORA-31608 from a dependent kind as none of it', async () => {
    const { reader } = dictionary({});
    const dump = await reader.getTableDump(customers);
    expect(dump.create).toHaveLength(1);
    expect(dump.after).toEqual([]);
  });

  it('passes on any other error from a dependent kind', async () => {
    const failure = new DbError('permission-denied', 'ORA-31603', { driverCode: 'ORA-01031' });
    const { reader } = dictionary({ ...everything, COMMENT: failure });
    await expect(reader.getTableDump(customers)).rejects.toBe(failure);
  });

  it('defines a table with its keys inline and its triggers after', async () => {
    const { reader, asked } = dictionary(everything);
    expect(await reader.getDefinition({ kind: 'table', ...customers })).toEqual([
      'CREATE TABLE "DATANEST"."CUSTOMERS" (\n "ID" NUMBER,\n CONSTRAINT "PK_CUSTOMERS" PRIMARY KEY ("ID")\n  )',
      'CREATE INDEX "DATANEST"."IX_NAME" ON "DATANEST"."CUSTOMERS" ("NAME")',
      'COMMENT ON TABLE "DATANEST"."CUSTOMERS" IS \'People\'',
      'CREATE OR REPLACE EDITIONABLE TRIGGER "DATANEST"."TR"\nBEFORE INSERT ON "DATANEST"."CUSTOMERS"\nBEGIN\n  NULL;\nEND;',
      'ALTER TRIGGER "DATANEST"."TR" ENABLE',
    ]);
    expect(asked[0]?.sql).toContain("'REF_CONSTRAINTS', TRUE");
    expect(asked.some((question) => question.binds?.type === 'REF_CONSTRAINT')).toBe(false);
  });

  it('owns its triggers without a schema when the table has none', async () => {
    const { reader, asked } = dictionary(everything);
    const dump = await reader.getTableDump({ name: 'CUSTOMERS' });
    expect(dump.owns).toEqual([{ kind: 'trigger', name: 'TR', table: 'CUSTOMERS' }]);
    expect(
      asked.every((question) => question.binds === undefined || question.binds.owner === ''),
    ).toBe(true);
  });
});

describe('names written in lower case', () => {
  /** A dictionary that knows these owners and objects, and answers the two lookups. */
  function dictionary(objects: readonly (readonly [string, string])[], users: readonly string[]) {
    return metadata((sql, binds) => {
      if (sql.includes('FROM all_objects')) {
        const owners = [binds?.owner === '' ? 'DATANEST' : (binds?.owner ?? '')];
        owners.push(owners[0]?.toUpperCase() ?? '');
        const names = [binds?.name ?? '', (binds?.name ?? '').toUpperCase()];
        return objects
          .filter(([owner, name]) => owners.includes(owner) && names.includes(name))
          .map(([owner, name]) => [owner, name]);
      }
      if (sql.includes('FROM all_users')) {
        const wanted = [binds?.owner ?? '', (binds?.owner ?? '').toUpperCase()];
        return users.filter((user) => wanted.includes(user)).map((user) => [user]);
      }
      return [];
    });
  }

  it('reads an unquoted name the way Oracle does: in upper case', async () => {
    const { reader, asked } = dictionary([['DATANEST', 'CUSTOMERS']], ['DATANEST']);
    await reader.listColumns({ schema: 'datanest', name: 'customers' });
    expect(asked.at(-1)?.binds).toEqual({ owner: 'DATANEST', name: 'CUSTOMERS' });
  });

  it('prefers an object really named in lower case', async () => {
    const { reader, asked } = dictionary(
      [
        ['DATANEST', 'CUSTOMERS'],
        ['DATANEST', 'customers'],
      ],
      ['DATANEST'],
    );
    await reader.listIndexes({ schema: 'DATANEST', name: 'customers' });
    expect(asked.at(-1)?.binds).toEqual({ owner: 'DATANEST', name: 'customers' });
  });

  it('looks in the current schema when the reference names none', async () => {
    const { reader, asked } = dictionary([['DATANEST', 'ORDERS']], []);
    await reader.listForeignKeys({ name: 'orders' });
    expect(asked[0]?.binds).toEqual({ owner: '', name: 'orders' });
    expect(asked.at(-1)?.binds).toEqual({ owner: '', name: 'ORDERS' });
  });

  it('keeps a name nothing matches, so the server can say it is not there', async () => {
    const { reader, asked } = dictionary([], []);
    await reader.listUniqueKeys({ schema: 'nobody', name: 'nothing' });
    expect(asked.at(-1)?.binds).toEqual({ owner: 'nobody', name: 'nothing' });
  });

  it('asks nothing extra for names without lower-case letters', async () => {
    const { reader, asked } = dictionary([], []);
    await reader.listColumns({ schema: 'DATANEST', name: 'ORDER_ITEMS_2' });
    await reader.listTables({ schema: 'INVENTORY' });
    expect(asked.map((entry) => entry.sql).join('\n')).not.toMatch(/all_objects|all_users/u);
  });

  it('reads the schema of a scope in upper case too', async () => {
    const { reader, asked } = dictionary([], ['INVENTORY']);
    await reader.listTables({ schema: 'inventory' });
    await reader.listObjects({ schema: 'inventory' }, 'procedure');
    expect(asked.filter((entry) => !entry.sql.includes('all_users')).map((e) => e.binds)).toEqual([
      { owner: 'INVENTORY' },
      { owner: 'INVENTORY', type: 'PROCEDURE' },
    ]);
  });

  it('resolves a definition and a dump of a table named in lower case', async () => {
    const { reader, asked } = metadata((sql, binds) => {
      if (sql.includes('FROM all_objects')) {
        return [['DATANEST', 'ORDERS']];
      }
      if (sql.includes('GET_DDL')) {
        return [[`CREATE TABLE "DATANEST"."${binds?.name ?? ''}" ("ID" NUMBER);`]];
      }
      return [];
    });
    expect(
      await reader.getDefinition({ kind: 'view', schema: 'datanest', name: 'orders' }),
    ).toEqual(['CREATE TABLE "DATANEST"."ORDERS" ("ID" NUMBER)']);
    expect(asked.find((entry) => entry.sql.includes('GET_DDL'))?.binds).toMatchObject({
      name: 'ORDERS',
      owner: 'DATANEST',
    });
    const dump = await reader.getTableDump({ schema: 'datanest', name: 'orders' });
    expect(dump.create[0]).toContain('"ORDERS"');
  });
});
