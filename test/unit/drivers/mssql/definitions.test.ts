import { describe, expect, it } from 'vitest';
import type { ForeignKey } from '../../../../src/core/model/objects';
import {
  describeSql,
  readMssqlDefinition,
  tableParts,
} from '../../../../src/drivers/mssql/definitions';

/** A catalog that answers by a phrase of each query, the way the readers ask. */
function catalog(answers: Record<string, unknown[][]>) {
  const asked: { sql: string; params: readonly (string | number)[] | undefined }[] = [];
  const read = (sql: string, params?: readonly (string | number)[]) => {
    asked.push({ sql, params });
    const key = Object.keys(answers).find((phrase) => sql.includes(phrase));
    return Promise.resolve(key === undefined ? [] : (answers[key] ?? []));
  };
  return { read, asked };
}

function keys(list: ForeignKey[] = []) {
  return { listForeignKeys: () => Promise.resolve(list) };
}

const EXISTS = "OBJECT_ID(@p1, N'U')";
const COLUMNS = 'sys.identity_columns';
const KEYS = 'FROM sys.key_constraints kc';
const CHECKS = 'FROM sys.check_constraints';
const INDEXES = 'is_hypothetical';
const DESCRIPTIONS = 'ORDER BY ep.minor_id';
const SYSTEM_KEYS = 'is_system_named = 1';
const TRIGGERS = 'FROM sys.triggers tr WHERE tr.parent_id';
const MODULE = 'OBJECT_DEFINITION(o.object_id)';
const SEQUENCE = 'FROM sys.sequences s';

/** One column row: name, type, nullable, identity, seed, step, computed, persisted,
 * default name, default, collation, database collation, rowguidcol. */
function columnRow(name: string, type: string, overrides: Partial<Record<number, unknown>> = {}) {
  const row: unknown[] = [
    name,
    type,
    true,
    false,
    null,
    null,
    null,
    false,
    null,
    null,
    null,
    'DB_CI',
    false,
  ];
  for (const [index, value] of Object.entries(overrides)) {
    row[Number(index)] = value;
  }
  return row;
}

describe('tableParts', () => {
  it('builds CREATE TABLE from columns, keys and checks, then indexes and descriptions', async () => {
    const { read } = catalog({
      [EXISTS]: [[123]],
      [COLUMNS]: [
        columnRow('id', 'int', { 2: false, 3: true, 4: '1', 5: '1' }),
        columnRow('code', 'varchar(10)', { 10: 'Latin1_General_BIN', 9: "('x')", 8: 'df_code' }),
        columnRow('created', 'datetime2(0)', { 2: false, 9: '(sysdatetime())' }),
        columnRow('total', 'int', { 6: '([a]+[b])', 7: true }),
        columnRow('half', 'int', { 6: '([a]/(2))' }),
        columnRow('guid', 'uniqueidentifier', { 12: true, 10: 'DB_CI' }),
      ],
      [KEYS]: [
        ['PK__t__3213E83F', 'PK', 'CLUSTERED', 'id', false, true],
        ['uq_code', 'UQ', 'NONCLUSTERED', 'code', true, false],
        ['uq_code', 'UQ', 'NONCLUSTERED', 'created', false, false],
      ],
      [CHECKS]: [
        ['CK__t__total__1', '([total]>(0))', true],
        ['ck_code', "([code]<>'')", false],
      ],
      [INDEXES]: [
        ['ix_created', false, 'NONCLUSTERED', '([code] IS NOT NULL)', 'created', true, false, 2],
        ['ix_created', false, 'NONCLUSTERED', '([code] IS NOT NULL)', 'total', false, true, 2],
        ['cci', false, 'CLUSTERED COLUMNSTORE', null, 'id', false, false, 5],
        ['ncci', false, 'NONCLUSTERED COLUMNSTORE', null, 'code', false, true, 6],
      ],
      [DESCRIPTIONS]: [
        [null, "the t's table"],
        ['code', 'a code'],
      ],
      [TRIGGERS]: [['tr_t', 'CREATE TRIGGER tr_t ON t AFTER INSERT AS SELECT 1;  ']],
    });
    const parts = await tableParts(read, { schema: 'app', name: 't' }, keys());
    expect(parts.create).toEqual([
      [
        'CREATE TABLE [app].[t] (',
        '  [id] int IDENTITY(1, 1) NOT NULL,',
        "  [code] varchar(10) COLLATE Latin1_General_BIN NULL CONSTRAINT [df_code] DEFAULT ('x'),",
        '  [created] datetime2(0) NOT NULL DEFAULT (sysdatetime()),',
        '  [total] AS ([a]+[b]) PERSISTED,',
        '  [half] AS ([a]/(2)),',
        '  [guid] uniqueidentifier ROWGUIDCOL NULL,',
        '  PRIMARY KEY CLUSTERED ([id]),',
        '  CONSTRAINT [uq_code] UNIQUE NONCLUSTERED ([code] DESC, [created]),',
        '  CHECK ([total]>(0)),',
        "  CONSTRAINT [ck_code] CHECK ([code]<>'')",
        ')',
      ].join('\n'),
      'CREATE NONCLUSTERED INDEX [ix_created] ON [app].[t] ([created] DESC) INCLUDE ([total]) WHERE ([code] IS NOT NULL)',
      'CREATE CLUSTERED COLUMNSTORE INDEX [cci] ON [app].[t]',
      'CREATE NONCLUSTERED COLUMNSTORE INDEX [ncci] ON [app].[t] ([code])',
      "EXEC sp_addextendedproperty N'MS_Description', N'the t''s table', N'SCHEMA', N'app', N'TABLE', N't'",
      "EXEC sp_addextendedproperty N'MS_Description', N'a code', N'SCHEMA', N'app', N'TABLE', N't', N'COLUMN', N'code'",
    ]);
    expect(parts.triggers).toEqual(['CREATE TRIGGER tr_t ON t AFTER INSERT AS SELECT 1']);
    expect(parts.triggerNames).toEqual(['tr_t']);
    expect(parts.keys).toEqual([]);
  });

  it('writes foreign keys apart, without the names the server made up', async () => {
    const { read } = catalog({
      [EXISTS]: [[1]],
      [COLUMNS]: [columnRow('customer_id', 'int')],
      [SYSTEM_KEYS]: [['FK__orders__custo__3B75D760']],
    });
    const parts = await tableParts(
      read,
      { name: 'orders' },
      keys([
        {
          name: 'FK__orders__custo__3B75D760',
          columns: ['customer_id'],
          target: { schema: 'dbo', name: 'customers' },
          targetColumns: ['id'],
          onDelete: 'NO ACTION',
          onUpdate: 'NO ACTION',
        },
        {
          name: 'fk_two',
          columns: ['a', 'b'],
          target: { name: 'pairs' },
          targetColumns: ['x', 'y'],
          onDelete: 'CASCADE',
          onUpdate: 'SET NULL',
        },
      ]),
    );
    expect(parts.keys).toEqual([
      'ALTER TABLE [dbo].[orders] ADD FOREIGN KEY ([customer_id]) REFERENCES [dbo].[customers] ([id])',
      'ALTER TABLE [dbo].[orders] ADD CONSTRAINT [fk_two] FOREIGN KEY ([a], [b]) REFERENCES [dbo].[pairs] ([x], [y]) ON DELETE CASCADE ON UPDATE SET NULL',
    ]);
  });

  it('asks every catalog query about the quoted two-part name', async () => {
    const { read, asked } = catalog({ [EXISTS]: [[1]] });
    await tableParts(read, { schema: 's', name: 'a]b' }, keys());
    expect(asked.every((query) => query.params?.[0] === '[s].[a]]b]')).toBe(true);
    expect(asked.find((query) => query.sql.includes(DESCRIPTIONS))?.params).toEqual([
      '[s].[a]]b]',
      'MS_Description',
    ]);
  });

  it('says not-found for a table that does not exist', async () => {
    const { read } = catalog({ [EXISTS]: [[null]] });
    await expect(tableParts(read, { name: 'nope' }, keys())).rejects.toMatchObject({
      code: 'not-found',
      message: 'dbo.nope does not exist',
    });
    await expect(tableParts(catalog({}).read, { name: 'nope' }, keys())).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses a trigger whose definition the server hides', async () => {
    const { read } = catalog({ [EXISTS]: [[1]], [TRIGGERS]: [['secret', null]] });
    await expect(tableParts(read, { name: 't' }, keys())).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});

describe('readMssqlDefinition', () => {
  it('joins the table, its keys and triggers', async () => {
    const { read } = catalog({
      [EXISTS]: [[1]],
      [COLUMNS]: [columnRow('id', 'int', { 2: false })],
      [TRIGGERS]: [['tr', 'CREATE TRIGGER tr ON t AFTER DELETE AS SELECT 1']],
    });
    const statements = await readMssqlDefinition(
      read,
      { kind: 'table', name: 't' },
      keys([{ name: 'fk', columns: ['id'], target: { name: 'u' }, targetColumns: ['id'] }]),
    );
    expect(statements).toEqual([
      'CREATE TABLE [dbo].[t] (\n  [id] int NOT NULL\n)',
      'ALTER TABLE [dbo].[t] ADD CONSTRAINT [fk] FOREIGN KEY ([id]) REFERENCES [dbo].[u] ([id])',
      'CREATE TRIGGER tr ON t AFTER DELETE AS SELECT 1',
    ]);
  });

  it.each(['view', 'function', 'procedure', 'trigger'] as const)(
    'reads a %s as written, without a trailing semicolon',
    async (kind) => {
      const { read, asked } = catalog({ [MODULE]: [[5, '\n CREATE THING x AS SELECT 1; \n']] });
      expect(await readMssqlDefinition(read, { kind, schema: 's', name: 'x' }, keys())).toEqual([
        'CREATE THING x AS SELECT 1',
      ]);
      expect(asked[0]?.params).toEqual(['[s].[x]']);
    },
  );

  it('says not-found for a missing object and permission-denied for a hidden one', async () => {
    await expect(
      readMssqlDefinition(catalog({}).read, { kind: 'view', name: 'v' }, keys()),
    ).rejects.toMatchObject({ code: 'not-found', message: 'dbo.v does not exist' });
    await expect(
      readMssqlDefinition(
        catalog({ [MODULE]: [[5, null]] }).read,
        { kind: 'procedure', name: 'p' },
        keys(),
      ),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('builds a sequence from its settings', async () => {
    const { read } = catalog({
      [SEQUENCE]: [
        [
          'bigint',
          '1000',
          '1',
          '-9223372036854775808',
          '9223372036854775807',
          false,
          true,
          null,
          19,
          0,
        ],
      ],
    });
    expect(await readMssqlDefinition(read, { kind: 'sequence', name: 'seq' }, keys())).toEqual([
      'CREATE SEQUENCE [dbo].[seq] AS bigint START WITH 1000 INCREMENT BY 1 MINVALUE -9223372036854775808 MAXVALUE 9223372036854775807 NO CYCLE CACHE',
    ]);
  });

  it('writes the precision of a decimal sequence, its cache size and cycling', async () => {
    const cached = catalog({
      [SEQUENCE]: [['decimal', '1', '5', '1', '999', true, true, 50, 10, 0]],
    });
    expect(
      await readMssqlDefinition(cached.read, { kind: 'sequence', schema: 's', name: 'q' }, keys()),
    ).toEqual([
      'CREATE SEQUENCE [s].[q] AS decimal(10, 0) START WITH 1 INCREMENT BY 5 MINVALUE 1 MAXVALUE 999 CYCLE CACHE 50',
    ]);
    const uncached = catalog({
      [SEQUENCE]: [['int', '1', '1', '1', '9', false, false, null, 10, 0]],
    });
    const [sql] = await readMssqlDefinition(uncached.read, { kind: 'sequence', name: 'q' }, keys());
    expect(sql?.endsWith('NO CYCLE NO CACHE')).toBe(true);
    await expect(
      readMssqlDefinition(catalog({}).read, { kind: 'sequence', name: 'q' }, keys()),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('has no events', async () => {
    await expect(
      readMssqlDefinition(catalog({}).read, { kind: 'event', name: 'e' }, keys()),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('describeSql', () => {
  it('adds, updates and drops a description of a table or a column', () => {
    const table = { schema: 'dbo', name: 't' };
    expect(describeSql(table, undefined, 'x')).toBe(
      "EXEC sp_addextendedproperty N'MS_Description', N'x', N'SCHEMA', N'dbo', N'TABLE', N't'",
    );
    expect(describeSql(table, 'c', 'y', 'sp_updateextendedproperty')).toBe(
      "EXEC sp_updateextendedproperty N'MS_Description', N'y', N'SCHEMA', N'dbo', N'TABLE', N't', N'COLUMN', N'c'",
    );
    expect(describeSql(table, 'c', 'ignored', 'sp_dropextendedproperty')).toBe(
      "EXEC sp_dropextendedproperty N'MS_Description', N'SCHEMA', N'dbo', N'TABLE', N't', N'COLUMN', N'c'",
    );
  });
});
