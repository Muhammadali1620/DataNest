import { describe, expect, it } from 'vitest';
import { Neo4jMetadata, stringsOf } from '../../../../src/drivers/neo4j/metadata';
import type { CellValue } from '../../../../src/shared/cell-value';

type Parameters = Readonly<Record<string, unknown>> | undefined;

/** A reader that answers from a script and remembers what it was asked. */
function reader(answer: (cypher: string, parameters: Parameters) => CellValue[][]) {
  const asked: { cypher: string; parameters: Parameters }[] = [];
  return {
    asked,
    metadata: new Neo4jMetadata({
      queryRows: (cypher, parameters) => {
        asked.push({ cypher, parameters });
        return Promise.resolve(answer(cypher, parameters));
      },
    }),
  };
}

const json = (value: unknown): CellValue => ({ kind: 'json', text: JSON.stringify(value) });

describe('stringsOf', () => {
  it('reads a list cell', () => {
    expect(stringsOf(json(['a', 'b']))).toEqual(['a', 'b']);
    expect(stringsOf(json(['a', 1, null]))).toEqual(['a']);
  });

  it('is empty for anything else', () => {
    expect(stringsOf(undefined)).toEqual([]);
    expect(stringsOf(null)).toEqual([]);
    expect(stringsOf('a')).toEqual([]);
    expect(stringsOf(json({ a: 1 }))).toEqual([]);
    expect(stringsOf({ kind: 'json', text: 'not json' })).toEqual([]);
  });
});

describe('Neo4jMetadata', () => {
  it('lists the databases', async () => {
    const { metadata } = reader(() => [['neo4j'], ['system'], ['']]);
    expect(await metadata.listDatabases()).toEqual(['neo4j', 'system']);
    expect(await metadata.listSchemas()).toEqual([]);
  });

  it('lists labels as tables and relationship types as views between brackets', async () => {
    const { metadata } = reader((cypher) =>
      cypher.includes('db.labels') ? [['Person'], ['City'], ['']] : [['KNOWS'], ['']],
    );
    expect(await metadata.listTables({})).toEqual([
      { name: 'Person', kind: 'table' },
      { name: 'City', kind: 'table' },
      { name: '[KNOWS]', kind: 'view' },
    ]);
  });

  it('describes a label: its parts, then its properties by name', async () => {
    const { metadata, asked } = reader(() => [
      ['zeta', json(['String']), true],
      ['alpha', json(['Long', 'Double']), false],
      ['alpha', json(['Long']), false],
      ['', json([]), false],
      ['nothing', json([]), 'x'],
    ]);
    const columns = await metadata.listColumns({ name: 'Person' });
    expect(columns.map((column) => column.name)).toEqual([
      '_id',
      '_labels',
      'alpha',
      'nothing',
      'zeta',
    ]);
    expect(columns[1]).toMatchObject({ dataType: 'list', nullable: false });
    expect(columns[2]).toMatchObject({ dataType: 'long | double', nullable: true });
    expect(columns[3]).toMatchObject({ dataType: 'any', nullable: true });
    expect(columns[4]).toMatchObject({ dataType: 'string', nullable: false, primaryKey: false });
    expect(asked[0]?.parameters).toEqual({ name: 'Person' });
    expect(asked[0]?.cypher).toContain('nodeTypeProperties');
  });

  it('describes a relationship type with its ends', async () => {
    const { metadata, asked } = reader(() => [['since', json(['Long']), false]]);
    const columns = await metadata.listColumns({ name: '[KNOWS]' });
    expect(columns.map((column) => column.name)).toEqual(['_id', '_type', '_from', '_to', 'since']);
    expect(asked[0]?.cypher).toContain('relTypeProperties');
    expect(asked[0]?.parameters).toEqual({ name: ':`KNOWS`' });
    await metadata.listColumns({ name: '[a`b]' });
    expect(asked[1]?.parameters).toEqual({ name: ':`a``b`' });
  });

  it('lists the indexes of a label, unique ones marked', async () => {
    const { metadata, asked } = reader(() => [
      ['person_age', 'RANGE', json(['age']), false],
      ['person_name', 'RANGE', json(['name']), true],
    ]);
    expect(await metadata.listIndexes({ name: 'Person' })).toEqual([
      { name: 'person_age', columns: ['age'], unique: false, primary: false, method: 'RANGE' },
      { name: 'person_name', columns: ['name'], unique: true, primary: false, method: 'RANGE' },
    ]);
    await metadata.listIndexes({ name: '[KNOWS]' });
    expect(asked[1]?.parameters).toEqual({ name: 'KNOWS' });
  });

  it('writes the definition of a label as its indexes and constraints', async () => {
    const { metadata } = reader((cypher) =>
      cypher.includes('SHOW INDEXES')
        ? [['CREATE INDEX a FOR (n:`P`) ON (n.`a`)']]
        : [['CREATE CONSTRAINT c FOR (n:`P`) REQUIRE n.`b` IS UNIQUE'], [' ']],
    );
    expect(await metadata.getDefinition({ kind: 'table', name: 'P' })).toEqual([
      'CREATE INDEX a FOR (n:`P`) ON (n.`a`)',
      'CREATE CONSTRAINT c FOR (n:`P`) REQUIRE n.`b` IS UNIQUE',
    ]);
  });

  it('says so when there is nothing to write, and refuses routines', async () => {
    const { metadata } = reader(() => []);
    expect(await metadata.getDefinition({ kind: 'view', name: '[KNOWS]' })).toEqual([
      '// [KNOWS] has no indexes or constraints',
    ]);
    await expect(metadata.getDefinition({ kind: 'function', name: 'f' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('has no keys, foreign keys, routines, designer or dump', async () => {
    const { metadata } = reader(() => []);
    expect(await metadata.listUniqueKeys()).toEqual([]);
    expect(await metadata.listForeignKeys()).toEqual([]);
    expect(await metadata.listObjects({}, 'function')).toEqual([]);
    expect(await metadata.listTypeDumps()).toEqual([]);
    await expect(metadata.describeTable()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(metadata.getTableDump()).rejects.toMatchObject({ code: 'unsupported' });
  });
});
