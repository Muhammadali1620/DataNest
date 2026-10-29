// Structure changes on SQL Server (V3 on V6.2): the SQL the dialect builds for the
// table designer, the tree's actions and edited definitions runs on the real server,
// and the catalogs show the result.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/mssql';
import { designFromStructure } from '../../../src/services/table-structure';
import type { NO_BACKGROUND } from '../../../src/shared/table-design';
import { type TableDesign } from '../../../src/shared/table-design';
import { testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';

const { ddl } = driver.dialect;
const SCOPE = { schema: 'dbo' };
/** createTable takes the scope from a reference; the name comes from the design. */
const HERE = { schema: 'dbo', name: '' };

describe('structure changes on SQL Server', () => {
  let session: Session;

  async function each(statements: readonly string[]): Promise<void> {
    for (const sql of statements) {
      await runAll(session, sql);
    }
  }

  async function dropAll(): Promise<void> {
    await runAll(session, 'DROP TABLE IF EXISTS dbo.st_child, dbo.st_people, dbo.st_renamed');
    await runAll(session, 'DROP VIEW IF EXISTS dbo.st_view');
    await runAll(session, 'DROP PROCEDURE IF EXISTS dbo.st_proc');
    await runAll(session, 'DROP SCHEMA IF EXISTS st_schema');
  }

  beforeAll(async () => {
    const db = testDatabase('mssql');
    session = await driver.openSession({
      id: 'st',
      name: 'mssql',
      driver: 'mssql',
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
    });
  });

  beforeEach(async () => {
    await dropAll();
  });

  afterAll(async () => {
    await dropAll();
    await session.close();
  });

  const people: TableDesign = {
    name: 'st_people',
    comment: "People, with a quote: '",
    columns: [
      {
        id: 'c1',
        name: 'id',
        type: 'int',
        length: '',
        nullable: false,
        defaultValue: '',
        autoIncrement: true,
        primaryKey: true,
        comment: '',
      },
      {
        id: 'c2',
        name: 'email',
        type: 'nvarchar',
        length: '120',
        nullable: false,
        defaultValue: '',
        autoIncrement: false,
        primaryKey: false,
        comment: 'Login',
      },
      {
        id: 'c3',
        name: 'score',
        type: 'decimal',
        length: '6,2',
        nullable: true,
        defaultValue: '0',
        autoIncrement: false,
        primaryKey: false,
        comment: '',
      },
      {
        id: 'c4',
        name: 'joined',
        type: 'datetime2',
        length: '0',
        nullable: true,
        defaultValue: 'SYSDATETIME()',
        autoIncrement: false,
        primaryKey: false,
        comment: '',
      },
    ],
    indexes: [{ id: 'i1', name: 'ux_st_people_email', columns: ['c2'], unique: true }],
    foreignKeys: [],
  };

  async function load(
    name: string,
  ): Promise<{ design: TableDesign; background: typeof NO_BACKGROUND }> {
    const table = { ...SCOPE, name };
    const loaded = designFromStructure(table, await session.metadata.describeTable(table));
    return { design: loaded.design, background: loaded.background };
  }

  it('creates a designed table with identity, defaults, an index and descriptions', async () => {
    await each(ddl.createTable(HERE, people));
    const structure = await session.metadata.describeTable({ ...SCOPE, name: 'st_people' });
    expect(structure.comment).toBe("People, with a quote: '");
    expect(
      structure.columns.map((column) => [column.name, column.dataType, column.autoIncrement]),
    ).toEqual([
      ['id', 'int', true],
      ['email', 'nvarchar(120)', false],
      ['score', 'decimal(6,2)', false],
      ['joined', 'datetime2(0)', false],
    ]);
    expect(structure.columns[1]?.comment).toBe('Login');
    expect(structure.columns[3]?.defaultExpression).toBe('sysdatetime()');
    expect(structure.indexes.find((index) => index.name === 'ux_st_people_email')?.unique).toBe(
      true,
    );
    await runAll(session, "INSERT INTO dbo.st_people (email) VALUES (N'a@b.c')");
    expect(firstColumn(await runAll(session, 'SELECT score FROM dbo.st_people'))).toEqual([
      { kind: 'decimal', text: '0.00' },
    ]);
  });

  it('alters a loaded table: rename, retype, defaults, comments, columns, keys', async () => {
    await each(ddl.createTable(HERE, people));
    await each(
      ddl.createTable(HERE, {
        name: 'st_child',
        comment: '',
        columns: [
          {
            id: 'k1',
            name: 'id',
            type: 'int',
            length: '',
            nullable: false,
            defaultValue: '',
            autoIncrement: false,
            primaryKey: true,
            comment: '',
          },
          {
            id: 'k2',
            name: 'person',
            type: 'int',
            length: '',
            nullable: true,
            defaultValue: '',
            autoIncrement: false,
            primaryKey: false,
            comment: '',
          },
        ],
        indexes: [],
        foreignKeys: [],
      }),
    );
    await runAll(session, "INSERT INTO dbo.st_people (email, score) VALUES (N'x@y.z', 1.5)");
    const { design: before, background } = await load('st_people');
    // A nonclustered index the designer made is the designer's to change again.
    expect(before.indexes.map((index) => index.name)).toEqual(['ux_st_people_email']);
    expect(background.fixedIndexes).toEqual([]);
    const columns = before.columns.map((column) => {
      switch (column.name) {
        case 'email':
          return { ...column, name: 'mail', length: '200', comment: '' };
        case 'score':
          return { ...column, type: 'decimal', length: '8,3', defaultValue: '1', nullable: false };
        case 'joined':
          return { ...column, defaultValue: '' };
        default:
          return column;
      }
    });
    const after: TableDesign = {
      ...before,
      name: 'st_renamed',
      comment: '',
      columns: [
        ...columns,
        {
          id: 'new-1',
          name: 'nick',
          type: 'nvarchar',
          length: '30',
          nullable: true,
          defaultValue: "N'none'",
          autoIncrement: false,
          primaryKey: false,
          comment: 'Nickname',
        },
      ],
    };
    const plan = ddl.alterTable({ ...SCOPE, name: 'st_people' }, before, after, background);
    await each(plan.statements);

    const structure = await session.metadata.describeTable({ ...SCOPE, name: 'st_renamed' });
    expect(structure.comment).toBeUndefined();
    const byName = new Map(structure.columns.map((column) => [column.name, column]));
    expect(byName.get('mail')).toMatchObject({ dataType: 'nvarchar(200)' });
    expect(byName.get('mail')?.comment).toBeUndefined();
    expect(byName.get('score')).toMatchObject({
      dataType: 'decimal(8,3)',
      nullable: false,
      defaultExpression: '1',
    });
    expect(byName.get('joined')?.defaultExpression).toBeUndefined();
    expect(byName.get('nick')).toMatchObject({ defaultExpression: "N'none'", comment: 'Nickname' });
    expect(firstColumn(await runAll(session, 'SELECT score FROM dbo.st_renamed'))).toEqual([
      { kind: 'decimal', text: '1.500' },
    ]);

    // A foreign key from the child, then away again with the column it uses.
    const child = await load('st_child');
    const personId = child.design.columns.find((column) => column.name === 'person')?.id ?? '';
    const keyed: TableDesign = {
      ...child.design,
      foreignKeys: [
        {
          id: 'f1',
          name: 'fk_st_child_person',
          columns: [personId],
          targetTable: 'st_renamed',
          targetColumns: ['id'],
          onDelete: 'RESTRICT',
          onUpdate: 'CASCADE',
        },
      ],
    };
    await each(
      ddl.alterTable({ ...SCOPE, name: 'st_child' }, child.design, keyed, child.background)
        .statements,
    );
    const keys = await session.metadata.listForeignKeys({ ...SCOPE, name: 'st_child' });
    expect(keys).toEqual([
      expect.objectContaining({
        name: 'fk_st_child_person',
        onDelete: 'NO ACTION',
        onUpdate: 'CASCADE',
      }),
    ]);
    const reloaded = await load('st_child');
    const dropped: TableDesign = {
      ...reloaded.design,
      columns: reloaded.design.columns.filter((column) => column.name !== 'person'),
      foreignKeys: [],
    };
    await each(
      ddl.alterTable({ ...SCOPE, name: 'st_child' }, reloaded.design, dropped, reloaded.background)
        .statements,
    );
    expect(
      (await session.metadata.listColumns({ ...SCOPE, name: 'st_child' })).map((c) => c.name),
    ).toEqual(['id']);
  });

  it('rolls a failed alteration back as a whole', async () => {
    await each(ddl.createTable(HERE, people));
    await runAll(session, "INSERT INTO dbo.st_people (email) VALUES (N'one'), (N'two')");
    const { design: before, background } = await load('st_people');
    // A unique index on a column whose values repeat fails after the rename went through.
    const after: TableDesign = {
      ...before,
      columns: before.columns.map((column) =>
        column.name === 'score' ? { ...column, name: 'points' } : column,
      ),
      indexes: [...before.indexes, { id: 'i9', name: 'ux_points', columns: ['c3'], unique: true }],
    };
    const plan = ddl.alterTable({ ...SCOPE, name: 'st_people' }, before, after, background);
    await expect(each(plan.statements)).rejects.toThrow();
    await each(plan.recovery);
    expect(
      (await session.metadata.listColumns({ ...SCOPE, name: 'st_people' })).map((c) => c.name),
    ).toContain('score');
  });

  it('refuses to add IDENTITY to an existing column', async () => {
    await each(ddl.createTable(HERE, people));
    const { design: before, background } = await load('st_people');
    const after = {
      ...before,
      columns: before.columns.map((column) => ({
        ...column,
        autoIncrement: column.name === 'score',
      })),
    };
    expect(() =>
      ddl.alterTable({ ...SCOPE, name: 'st_people' }, before, after, background),
    ).toThrow(/IDENTITY/u);
  });

  it('renames, truncates and drops tables, views and schemas from the tree', async () => {
    await each(ddl.createTable(HERE, people));
    await runAll(session, "INSERT INTO dbo.st_people (email) VALUES (N'one')");
    await runAll(session, ddl.truncateTable({ ...SCOPE, name: 'st_people' }));
    expect(firstColumn(await runAll(session, 'SELECT COUNT(*) FROM dbo.st_people'))).toEqual([0]);
    await runAll(
      session,
      ddl.renameRelation({ ...SCOPE, name: 'st_people' }, 'table', 'st_renamed'),
    );
    await runAll(session, 'CREATE VIEW dbo.st_view AS SELECT id FROM dbo.st_renamed');
    await runAll(session, ddl.dropRelation({ ...SCOPE, name: 'st_view' }, 'view'));
    await runAll(session, ddl.dropRelation({ ...SCOPE, name: 'st_renamed' }, 'table'));
    expect((await session.metadata.listTables(SCOPE)).map((table) => table.name)).not.toContain(
      'st_renamed',
    );
    const createSchema = ddl.createSchema;
    const dropSchema = ddl.dropSchema;
    if (createSchema === undefined || dropSchema === undefined) {
      throw new Error('SQL Server has schemas');
    }
    await runAll(session, createSchema('st_schema'));
    expect(await session.metadata.listSchemas()).toContain('st_schema');
    await runAll(session, dropSchema('st_schema', false));
    expect(await session.metadata.listSchemas()).not.toContain('st_schema');
  });

  it('replaces an edited procedure in one transaction, and keeps the old one when the new fails', async () => {
    await runAll(session, 'CREATE PROCEDURE dbo.st_proc AS SELECT 1 AS answer');
    const object = { kind: 'procedure' as const, schema: 'dbo', name: 'st_proc' };
    const [original] = await session.metadata.getDefinition(object);
    const edited = 'CREATE PROCEDURE dbo.st_proc AS\nBEGIN\n  SELECT 2 AS answer;\nEND';
    const plan = ddl.replaceObject(object, [edited], [original ?? '']);
    await each(plan.statements);
    expect(firstColumn(await runAll(session, 'EXEC dbo.st_proc'))).toEqual([2]);

    const broken = ddl.replaceObject(object, ['CREATE PROCEDURE dbo.st_proc AS SELEC 3'], [edited]);
    await expect(each(broken.statements)).rejects.toMatchObject({ code: 'syntax' });
    await each(broken.recovery);
    expect(firstColumn(await runAll(session, 'EXEC dbo.st_proc'))).toEqual([2]);
    await runAll(session, ddl.dropObject(object));
    expect(await session.metadata.listObjects(SCOPE, 'procedure')).not.toContainEqual(
      expect.objectContaining({ name: 'st_proc' }),
    );
  });
});
