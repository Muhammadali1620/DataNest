import { describe, expect, it } from 'vitest';
import { functionsOf } from '../../../../src/core/sql/functions';
import { isReadOnlyStatement } from '../../../../src/core/sql/read-only';
import { snippetsOf } from '../../../../src/core/sql/snippets';
import { splitStatements } from '../../../../src/core/sql/split';
import { syntaxOf, textOf, tokenize } from '../../../../src/core/sql/tokenizer';

const syntax = syntaxOf('neo4j');
const reads = (cypher: string): boolean => isReadOnlyStatement(cypher, syntax);

describe('the Cypher syntax', () => {
  it('has // comments, backslash escapes and backtick names, and no -- comments', () => {
    expect(syntax).toMatchObject({
      cypher: true,
      slashComments: true,
      dashComments: false,
      backslashEscapes: true,
      backtickIdentifiers: true,
      doubleQuoteIdentifiers: false,
      hashComments: false,
    });
  });

  it('reads // as a comment and -- as the edge it is', () => {
    const text = 'MATCH (a)--(b) // all pairs\nRETURN a';
    const tokens = tokenize(text, syntax);
    expect(tokens.filter((token) => token.kind === 'comment').map((t) => textOf(text, t))).toEqual([
      '// all pairs',
    ]);
  });

  it('keeps a semicolon inside a string or a backtick name', () => {
    expect(
      splitStatements("RETURN 'a;b'; RETURN `c;d`", 'neo4j').map((s) => s.text.trim()),
    ).toEqual(["RETURN 'a;b'", 'RETURN `c;d`']);
  });

  it('reads an escaped quote in a string', () => {
    expect(splitStatements("RETURN 'it\\'s; fine'; RETURN 2", 'neo4j')).toHaveLength(2);
  });

  it('is plain SQL for everything else', () => {
    expect(syntaxOf('mysql').cypher).toBeUndefined();
    expect(syntaxOf('mysql').dashComments).toBeUndefined();
    expect(syntaxOf().cypher).toBeUndefined();
  });
});

describe('what reads and what writes in Cypher', () => {
  it.each([
    'MATCH (n) RETURN n',
    'MATCH (n:Person) WHERE n.age > 3 RETURN n.name ORDER BY n.name SKIP 5 LIMIT 10',
    'OPTIONAL MATCH (a)-[r]->(b) RETURN a, r, b',
    'UNWIND [1, 2] AS x RETURN x',
    'WITH 1 AS a RETURN a',
    'RETURN 1',
    'SHOW DATABASES',
    'SHOW INDEXES',
    'EXPLAIN MATCH (n) DETACH DELETE n',
    'CALL db.labels()',
    'CALL db.schema.nodeTypeProperties() YIELD propertyName RETURN propertyName',
    'CALL dbms.components() YIELD name RETURN name',
    'MATCH (n) RETURN n // CREATE (:Nope)',
    "MATCH (n) WHERE n.note = 'DELETE me' RETURN n",
    '// only a comment',
    '',
    'SELECT * FROM `Person` LIMIT 5',
  ])('reads: %s', (cypher) => {
    expect(reads(cypher)).toBe(true);
  });

  it.each([
    'CREATE (:A)',
    'MERGE (n:A {id: 1})',
    'MATCH (n) DELETE n',
    'MATCH (n) DETACH DELETE n',
    'MATCH (n) SET n.a = 1',
    'MATCH (n) REMOVE n.a',
    'MATCH (n) FOREACH (x IN [1] | SET n.a = x)',
    "LOAD CSV FROM 'file:///x.csv' AS row RETURN row",
    'DROP INDEX a',
    'CREATE INDEX a FOR (n:A) ON (n.a)',
    'ALTER DATABASE neo4j SET ACCESS READ ONLY',
    'GRANT ROLE admin TO bob',
    'DENY MATCH {*} ON GRAPH neo4j TO bob',
    'REVOKE ROLE admin FROM bob',
    'START DATABASE neo4j',
    'STOP DATABASE neo4j',
    'TERMINATE TRANSACTIONS "x"',
    'CALL apoc.periodic.iterate("a", "b", {})',
    'CALL db.createLabel("X")',
    'CALL dbms.security.createUser("a", "b")',
    'CALL { CREATE (:A) }',
    "WITH 1 AS x CALL apoc.do.when(true, 'a') YIELD value RETURN value",
    'MATCH (n) RETURN n; CREATE (:A)',
  ])('writes: %s', (cypher) => {
    expect(reads(cypher)).toBe(false);
  });
});

describe('completion for Cypher', () => {
  it('offers Cypher functions and snippets, not the SQL ones', () => {
    const functions = functionsOf('neo4j').map((fn) => fn.name);
    expect(functions).toEqual(expect.arrayContaining(['labels', 'elementId', 'collect', 'count']));
    expect(functions).not.toContain('COALESCE');
    const prefixes = snippetsOf('neo4j').map((snippet) => snippet.prefix);
    expect(prefixes).toEqual(['match', 'rel', 'merge', 'count']);
    expect(prefixes).not.toContain('sel');
  });
});
