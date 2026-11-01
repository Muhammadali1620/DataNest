import { describe, expect, it } from 'vitest';
import {
  likeRegex,
  literal,
  neo4jDialect,
  paginate,
  quoteIdentifier,
  quoteString,
  quoteTable,
} from '../../../../src/drivers/neo4j/dialect';
import { driver } from '../../../../src/drivers/neo4j';

describe('quoting', () => {
  it('quotes names with backticks and doubles the ones inside', () => {
    expect(quoteIdentifier('Person')).toBe('`Person`');
    expect(quoteIdentifier('a`b')).toBe('`a``b`');
    expect(quoteTable({ name: 'Person' })).toBe('`Person`');
    expect(() => quoteIdentifier('')).toThrow(/empty/u);
    expect(() => quoteIdentifier('a\u0000b')).toThrow(/NUL/u);
  });

  it('quotes strings with single quotes and backslash escapes', () => {
    expect(quoteString("it's")).toBe("'it\\'s'");
    expect(quoteString('a\\b')).toBe("'a\\\\b'");
    expect(quoteString('a\nb\r')).toBe("'a\\nb\\r'");
  });
});

describe('literal', () => {
  it('writes every kind of value as Cypher', () => {
    expect(literal(null)).toBe('null');
    expect(literal(true)).toBe('true');
    expect(literal(false)).toBe('false');
    expect(literal(1.5)).toBe('1.5');
    expect(literal(Number.NaN)).toBe('(0.0/0.0)');
    expect(literal(Number.POSITIVE_INFINITY)).toBe('(1.0/0.0)');
    expect(literal(Number.NEGATIVE_INFINITY)).toBe('(-1.0/0.0)');
    expect(literal('x')).toBe("'x'");
    expect(literal({ kind: 'bigint', text: '9007199254740993' })).toBe('9007199254740993');
    expect(literal({ kind: 'bigint', text: 'oops' })).toBe("'oops'");
    expect(literal({ kind: 'decimal', text: '1.50' })).toBe('1.50');
    expect(literal({ kind: 'decimal', text: '1e5' })).toBe('1e5');
    expect(literal({ kind: 'decimal', text: 'x' })).toBe("'x'");
    expect(literal({ kind: 'datetime', text: '2020-01-01' })).toBe("'2020-01-01'");
    expect(literal({ kind: 'json', text: '{"a":1}' })).toBe('\'{"a":1}\'');
    expect(literal({ kind: 'binary', size: 2, preview: '00ff' })).toBe("'00ff'");
  });
});

describe('paginate', () => {
  it('puts the page at the end of the statement', () => {
    expect(paginate('SELECT * FROM `P`', 10, 0)).toBe('SELECT * FROM `P` LIMIT 10');
    expect(paginate('SELECT * FROM `P`;', 10, 20)).toBe('SELECT * FROM `P` SKIP 20 LIMIT 10');
    expect(paginate('MATCH (n) RETURN n  ', 5, 5)).toBe('MATCH (n) RETURN n SKIP 5 LIMIT 5');
  });

  it('refuses a page that makes no sense', () => {
    expect(() => paginate('x', -1, 0)).toThrow(/Invalid page/u);
    expect(() => paginate('x', 1, 1.5)).toThrow(/Invalid page/u);
  });
});

describe('likeRegex', () => {
  it('turns the filter patterns into case-insensitive regular expressions', () => {
    expect(likeRegex("'%ob%'")).toBe('(?is).*ob.*');
    expect(likeRegex("'A%'")).toBe('(?is)A.*');
    expect(likeRegex("'%z'")).toBe('(?is).*z');
    expect(likeRegex("'a_c'")).toBe('(?is)a.c');
  });

  it('reads the escape and escapes what a regular expression would read', () => {
    expect(likeRegex("'a!%b'")).toBe('(?is)a%b');
    expect(likeRegex("'a!_b'")).toBe('(?is)a_b');
    expect(likeRegex("'a!!b'")).toBe('(?is)a!b');
    expect(likeRegex("'1.5(x)[y]{z}+*?^$|'")).toBe(
      '(?is)1\\.5\\(x\\)\\[y\\]\\{z\\}\\+\\*\\?\\^\\$\\|',
    );
    expect(likeRegex("'a\\\\b'")).toBe('(?is)a\\\\b');
    expect(likeRegex("'trailing!'")).toBe('(?is)trailing!');
    expect(likeRegex("'a\\nb'")).toBe('(?is)a\nb');
  });

  it('is what the dialect uses for a contains condition', () => {
    expect(neo4jDialect.likeText('`name`', "'%x%'")).toBe("toString(`name`) =~ '(?is).*x.*'");
  });
});

describe('the dialect', () => {
  it('has Cypher keywords and no SQL ones', () => {
    expect(neo4jDialect.keywords).toContain('MATCH');
    expect(neo4jDialect.keywords).not.toContain('SELECT');
  });

  it('writes the statements it can', () => {
    expect(neo4jDialect.ddl.createDatabase?.('my db')).toBe('CREATE DATABASE `my db`');
    expect(neo4jDialect.ddl.dropDatabase?.('x')).toBe('DROP DATABASE `x`');
    expect(neo4jDialect.ddl.truncateTable({ name: 'P' })).toBe('MATCH (n:`P`) DETACH DELETE n');
    expect(neo4jDialect.insertDefaultRow('`P`')).toBe('CREATE (:`P`)');
    expect(neo4jDialect.defaultKeyword).toBe(false);
  });

  it('says what it cannot do', () => {
    const table = { name: 'P' };
    const design = {} as never;
    expect(() => neo4jDialect.ddl.createTable(table, design)).toThrow(/designer/u);
    expect(() => neo4jDialect.ddl.alterTable(table, design, design, {} as never)).toThrow(
      /designer/u,
    );
    expect(() => neo4jDialect.ddl.dropRelation(table, 'table')).toThrow(/dropped/u);
    expect(() => neo4jDialect.ddl.renameRelation(table, 'table', 'Q')).toThrow(/renamed/u);
    expect(() => neo4jDialect.ddl.dropObject({ kind: 'function', name: 'f' })).toThrow(/routines/u);
    expect(() => neo4jDialect.ddl.replaceObject({ kind: 'function', name: 'f' }, [], [])).toThrow(
      /routines/u,
    );
    expect(() => neo4jDialect.dump.insert('`P`', [], [], false)).toThrow(/dump/u);
    expect(() => neo4jDialect.dump.insertSelect('`P`', [], '', false)).toThrow(/dump/u);
    expect(() => neo4jDialect.dump.dropObject({ kind: 'function', name: 'f' })).toThrow(
      /routines/u,
    );
    expect(neo4jDialect.dump.dropRelations([table], 'table')).toEqual([]);
    expect(neo4jDialect.transaction.savepoint('a')).toBe('RETURN 1');
    expect(neo4jDialect.transaction.rollbackToSavepoint('a')).toBe('RETURN 1');
  });
});

describe('the driver', () => {
  it('is Neo4j, with one session per database and no transactions', () => {
    expect(driver.id).toBe('neo4j');
    expect(driver.dialect).toBe(neo4jDialect);
    expect(driver.capabilities).toMatchObject({
      databases: true,
      schemas: false,
      databaseScopedSessions: true,
      cancel: true,
      transactions: false,
    });
  });
});
