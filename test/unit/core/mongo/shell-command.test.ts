import { describe, expect, it } from 'vitest';
import { parseShellStatement, ShellSyntaxError } from '../../../../src/core/mongo/shell-command';
import { splitShellStatements, statementAt } from '../../../../src/core/mongo/shell-statements';
import { doc, int32, str } from '../../../../src/core/mongo/value';

function texts(text: string): string[] {
  return splitShellStatements(text).map((statement) => statement.text);
}

describe('splitShellStatements (V7.7)', () => {
  it('ends a statement at a semicolon or a line break', () => {
    expect(texts('use shop; show collections\ndb.a.find()\n\n\ndb.b.find()')).toEqual([
      'use shop',
      'show collections',
      'db.a.find()',
      'db.b.find()',
    ]);
  });

  it('keeps a statement whole across brackets and a chain on the next line', () => {
    const text =
      'db.orders.find({\n  a: 1;\n})\n  .sort({ b: -1 })\n  // a comment\n  .limit(5)\ndb.next()';
    expect(texts(text)).toEqual([
      'db.orders.find({\n  a: 1;\n})\n  .sort({ b: -1 })\n  // a comment\n  .limit(5)',
      'db.next()',
    ]);
  });

  it('goes on after a line that ends in a dot or a comma', () => {
    expect(texts('db.orders.\nfind()')).toEqual(['db.orders.\nfind()']);
    expect(texts('db.a.find({ a: 1 },\n{ b: 1 })')).toHaveLength(1);
  });

  it('does not split inside strings, comments or regular expressions', () => {
    expect(
      texts('db.a.find({ s: "x;\\"(y" }) // ; ( [\n/* ;\n */ db.b.find({ r: /a;[;)]/i })'),
    ).toEqual(['db.a.find({ s: "x;\\"(y" }) // ; ( [', 'db.b.find({ r: /a;[;)]/i })']);
  });

  it('skips blank and comment-only pieces and gives offsets of the code', () => {
    const text = '  // only a comment\n\n  db.a.find()  ;  ';
    const [statement] = splitShellStatements(text);
    expect(splitShellStatements(text)).toHaveLength(1);
    expect(statement?.text).toBe('db.a.find()');
    expect(text.slice(statement?.start, statement?.end)).toBe('db.a.find()');
    expect(splitShellStatements('')).toEqual([]);
  });

  it('survives text that never closes', () => {
    expect(texts('db.a.find({ "open')).toEqual(['db.a.find({ "open']);
    expect(texts('db.a.find({ /* open')).toHaveLength(1);
  });

  it('finds the statement at the cursor, or the last one before a blank line', () => {
    const text = 'db.a.find()\n\ndb.b.find()\n\n';
    expect(statementAt(text, 3)?.text).toBe('db.a.find()');
    expect(statementAt(text, 11)?.text).toBe('db.a.find()');
    expect(statementAt(text, 12)?.text).toBe('db.a.find()');
    expect(statementAt(text, text.length)?.text).toBe('db.b.find()');
    expect(statementAt('', 0)).toBeUndefined();
  });
});

describe('parseShellStatement (V7.7)', () => {
  it('reads use and show', () => {
    expect(parseShellStatement('use shop_2026')).toEqual({ kind: 'use', database: 'shop_2026' });
    expect(parseShellStatement('show dbs')).toEqual({ kind: 'show', what: 'databases' });
    expect(parseShellStatement('show databases;')).toEqual({ kind: 'show', what: 'databases' });
    expect(parseShellStatement('show collections')).toEqual({ kind: 'show', what: 'collections' });
    expect(parseShellStatement('show tables')).toEqual({ kind: 'show', what: 'collections' });
  });

  it('reads a collection method with its arguments and the chain after it', () => {
    expect(
      parseShellStatement('db.orders.find({ a: 1 }, { b: 1 }).sort({ c: -1 }).limit(5)'),
    ).toEqual({
      kind: 'call',
      collection: 'orders',
      call: { method: 'find', args: [doc([['a', int32(1)]]), doc([['b', int32(1)]])] },
      chain: [
        { method: 'sort', args: [doc([['c', int32(-1)]])] },
        { method: 'limit', args: [int32(5)] },
      ],
    });
  });

  it('names collections with dots, in brackets or through getCollection', () => {
    expect(parseShellStatement('db.orders.archive.find()')).toMatchObject({
      collection: 'orders.archive',
    });
    expect(parseShellStatement('db["my orders"].find()')).toMatchObject({
      collection: 'my orders',
    });
    expect(parseShellStatement("db.getCollection('a-b').countDocuments({})")).toMatchObject({
      collection: 'a-b',
      call: { method: 'countDocuments' },
    });
  });

  it('reads another database through getSiblingDB, and methods of a database', () => {
    expect(parseShellStatement('db.getSiblingDB("logs").events.find()')).toMatchObject({
      database: 'logs',
      collection: 'events',
    });
    expect(parseShellStatement('db.runCommand({ ping: 1 })')).toEqual({
      kind: 'call',
      call: { method: 'runCommand', args: [doc([['ping', int32(1)]])] },
      chain: [],
    });
    expect(parseShellStatement('db.getSiblingDB("admin").runCommand({ ping: 1 })')).toMatchObject({
      database: 'admin',
      call: { method: 'runCommand' },
    });
    expect(parseShellStatement('db.orders.distinct("city", {})')).toMatchObject({
      call: { method: 'distinct', args: [str('city'), doc([])] },
    });
  });

  it('allows spaces, line breaks and comments between the parts', () => {
    expect(
      parseShellStatement('db . orders\n  // why\n  .find( { } )\n  .limit( 2 ) ;'),
    ).toMatchObject({ collection: 'orders', chain: [{ method: 'limit' }] });
  });

  it.each([
    ['', 'There is no statement here'],
    ['orders.find()', 'a statement starts with db, use or show'],
    ['print("x")', '"print" is not something DataNest runs'],
    ['use', 'use expects the name of a database'],
    ['use a.b', 'use expects the name of a database'],
    ['show users', 'DataNest shows "dbs" and "collections"'],
    ['db', 'Expected "." and a method'],
    ['db.orders', 'Expected "." and a method'],
    ['db.orders.find(', 'Expected a value'],
    ['db.orders.find() x', 'the end of the statement'],
    ['db.orders.find().limit', 'Expected "(" after limit'],
    ['db.getCollection(1).find()', 'getCollection expects a name in quotes'],
    ['db[1].find()', 'A collection name in brackets goes in quotes'],
    ['db.orders.find(function () {})', 'DataNest reads data, not code'],
    ['db.orders.find(x => x)', 'Unknown value "x"'],
  ])('refuses %j', (text, message) => {
    expect(() => parseShellStatement(text)).toThrow(ShellSyntaxError);
    expect(() => parseShellStatement(text)).toThrow(message);
  });
});
