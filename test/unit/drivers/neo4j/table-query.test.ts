import { describe, expect, it } from 'vitest';
import {
  NODE_PARTS,
  quoteName,
  relationshipName,
  RELATIONSHIP_PARTS,
  translateTableQuery,
} from '../../../../src/drivers/neo4j/table-query';

describe('translateTableQuery', () => {
  it('turns a page of a label into a MATCH with the parts and the properties', () => {
    const query = translateTableQuery('SELECT * FROM `Person` LIMIT 100');
    expect(query).toEqual({
      kind: 'nodes',
      columns: '*',
      cypher:
        'MATCH (n:`Person`)\nRETURN elementId(n) AS `_id`, labels(n) AS `_labels`, properties(n) AS `_properties`\nLIMIT 100',
    });
  });

  it('keeps the offset as SKIP, and reads SKIP back', () => {
    expect(translateTableQuery('SELECT * FROM `P` LIMIT 10 OFFSET 20')?.cypher).toMatch(
      /\nSKIP 20\nLIMIT 10$/u,
    );
    expect(translateTableQuery('SELECT * FROM `P` SKIP 20 LIMIT 10')?.cypher).toMatch(
      /\nSKIP 20\nLIMIT 10$/u,
    );
    expect(translateTableQuery('SELECT * FROM `P` LIMIT 10 OFFSET 0')?.cypher).not.toContain(
      'SKIP',
    );
  });

  it('counts', () => {
    expect(translateTableQuery('SELECT COUNT(*) FROM `Person`')).toEqual({
      kind: 'nodes',
      columns: 'count',
      cypher: 'MATCH (n:`Person`)\nRETURN count(n) AS count',
    });
    expect(translateTableQuery('select count( * ) from `Person` where `age` > 3')?.cypher).toBe(
      'MATCH (n:`Person`)\nWHERE n.`age` > 3\nRETURN count(n) AS count',
    );
  });

  it('reads a relationship type written between brackets', () => {
    const query = translateTableQuery('SELECT * FROM `[KNOWS]` WHERE `since` > 2000 LIMIT 5');
    expect(query?.kind).toBe('relationships');
    expect(query?.cypher).toContain('MATCH ()-[n:`KNOWS`]->()');
    expect(query?.cypher).toContain('WHERE n.`since` > 2000');
    expect(query?.cypher).toContain('type(n) AS `_type`');
    expect(query?.cypher).toContain('elementId(startNode(n)) AS `_from`');
  });

  it('names the columns of an export', () => {
    const query = translateTableQuery('SELECT `name`, `age` FROM `Person`');
    expect(query?.columns).toEqual(['name', 'age']);
  });

  it('writes the parts of an entity as what they are', () => {
    const nodes = translateTableQuery(
      "SELECT * FROM `P` WHERE `_id` = 'x' AND `_labels` IS NOT NULL ORDER BY `_id` DESC",
    );
    expect(nodes?.cypher).toContain("WHERE elementId(n) = 'x' AND labels(n) IS NOT NULL");
    expect(nodes?.cypher).toContain('ORDER BY elementId(n) DESC');
    const relations = translateTableQuery(
      "SELECT * FROM `[R]` WHERE `_type` = 'R' AND `_from` <> 'a' AND `_to` <> 'b'",
    );
    expect(relations?.cypher).toContain(
      "WHERE type(n) = 'R' AND elementId(startNode(n)) <> 'a' AND elementId(endNode(n)) <> 'b'",
    );
  });

  it('quotes a name with a backtick in it', () => {
    const query = translateTableQuery('SELECT * FROM `we``ird` WHERE `a``b` = true');
    expect(query?.cypher).toContain('MATCH (n:`we``ird`)');
    expect(query?.cypher).toContain('WHERE n.`a``b` = true');
  });

  it('makes a number written as text match numbers too', () => {
    const equal = translateTableQuery("SELECT * FROM `P` WHERE `age` = '30'");
    expect(equal?.cypher).toContain("WHERE (toString(n.`age`) = '30')");
    const different = translateTableQuery("SELECT * FROM `P` WHERE `age` <> '30'");
    expect(different?.cypher).toContain("(toString(n.`age`) <> '30')");
    const more = translateTableQuery("SELECT * FROM `P` WHERE `age` >= '2.5' AND `b` = 'x'");
    expect(more?.cypher).toContain("(n.`age` >= '2.5' OR n.`age` >= 2.5) AND n.`b` = 'x'");
    // Text that is no number stays a text comparison.
    expect(translateTableQuery("SELECT * FROM `P` WHERE `name` = 'Ann'")?.cypher).toContain(
      "n.`name` = 'Ann'",
    );
  });

  it("leaves the user's own property references alone", () => {
    const query = translateTableQuery(
      "SELECT * FROM `P` WHERE (\nn.`weird name` > 3 AND n.age = 1\n) AND `name` = 'x'",
    );
    expect(query?.cypher).toContain('n.`weird name` > 3 AND n.age = 1');
    expect(query?.cypher).toContain("n.`name` = 'x'");
    expect(query?.cypher).not.toContain('n.n.');
  });

  it('keeps a backtick inside a string literal as text', () => {
    const query = translateTableQuery("SELECT * FROM `P` WHERE `a` = 'x`y'");
    expect(query?.cypher).toContain("n.`a` = 'x`y'");
  });

  it('reads the clauses in any case and ignores the ones inside parentheses or strings', () => {
    const query = translateTableQuery(
      "select * from `P` where `a` = 'ORDER BY LIMIT 5' and (`b` IN [1, 2]) order  by `a` asc limit 5",
    );
    expect(query?.cypher).toContain("WHERE n.`a` = 'ORDER BY LIMIT 5' and (n.`b` IN [1, 2])");
    expect(query?.cypher).toContain('ORDER BY n.`a` asc');
    expect(query?.cypher).toMatch(/LIMIT 5$/u);
  });

  it('ignores a semicolon at the end', () => {
    expect(translateTableQuery('SELECT * FROM `P`;')?.cypher).toContain('MATCH (n:`P`)');
  });

  it.each([
    'MATCH (n) RETURN n',
    'SELECT 1',
    'SELECT * FROM person',
    'SELECT * FROM `a`.`b`',
    'SELECT a + 1 FROM `P`',
    'SELECT `a` AS x FROM `P`',
    'SELECT * FROM `P` GROUP BY `a`',
    'SELECT * FROM `P` JOIN `Q` ON 1 = 1',
    'SELECT * FROM `P` LIMIT x',
    'SELECT * FROM `P` LIMIT 5 LIMIT 6',
    'SELECT COUNT(*), `a` FROM `P`',
    'SELECT FROM `P`',
    '',
  ])('leaves %j to the server', (sql) => {
    expect(translateTableQuery(sql)).toBeUndefined();
  });
});

describe('names', () => {
  it('quotes with backticks, doubling the ones inside', () => {
    expect(quoteName('a')).toBe('`a`');
    expect(quoteName('a`b')).toBe('`a``b`');
  });

  it('tells a relationship type from a label', () => {
    expect(relationshipName('[KNOWS]')).toBe('KNOWS');
    expect(relationshipName('[a b]')).toBe('a b');
    expect(relationshipName('Person')).toBeUndefined();
    expect(relationshipName('[]')).toBeUndefined();
  });

  it('lists the parts of an entity first', () => {
    expect(NODE_PARTS).toEqual(['_id', '_labels']);
    expect(RELATIONSHIP_PARTS).toEqual(['_id', '_type', '_from', '_to']);
  });
});
