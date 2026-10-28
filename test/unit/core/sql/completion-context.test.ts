import { describe, expect, it } from 'vitest';
import {
  completionContextAt,
  tableMentions,
  unquote,
} from '../../../../src/core/sql/completion-context';

/** Puts the cursor where `|` is and reads the context there. */
function at(sqlWithCursor: string, driver?: 'mysql' | 'postgres' | 'sqlite') {
  const offset = sqlWithCursor.indexOf('|');
  if (offset === -1) {
    throw new Error('Mark the cursor with |');
  }
  const sql = sqlWithCursor.replace('|', '');
  return completionContextAt(sql, offset, driver);
}

describe('completionContextAt', () => {
  describe('what is expected', () => {
    it('expects a table after FROM, JOIN, UPDATE and INTO', () => {
      expect(at('SELECT * FROM |').kind).toBe('table');
      expect(at('SELECT * FROM a JOIN |').kind).toBe('table');
      expect(at('UPDATE |').kind).toBe('table');
      expect(at('INSERT INTO |').kind).toBe('table');
    });

    it('starts afresh after the terminator of the previous statement', () => {
      expect(at('SELECT * FROM t; |')).toMatchObject({ kind: 'any', tables: [], prefix: '' });
      expect(at('SELECT * FROM t;\nsel|')).toMatchObject({ kind: 'any', prefix: 'sel' });
      // A comment after the statement is not a terminator.
      expect(at('SELECT * FROM t -- x\n|').kind).not.toBe('any');
    });

    it('expects a column after SELECT, WHERE, ON, SET, HAVING and BY', () => {
      expect(at('SELECT |').kind).toBe('column');
      expect(at('SELECT * FROM t WHERE |').kind).toBe('column');
      expect(at('SELECT * FROM a JOIN b ON |').kind).toBe('column');
      expect(at('UPDATE t SET |').kind).toBe('column');
      expect(at('SELECT 1 FROM t GROUP BY |').kind).toBe('column');
      expect(at('SELECT 1 FROM t ORDER BY |').kind).toBe('column');
      expect(at('SELECT 1 FROM t HAVING |').kind).toBe('column');
    });

    it('keeps the clause through commas and operators', () => {
      expect(at('SELECT a, |').kind).toBe('column');
      expect(at('SELECT * FROM a, |').kind).toBe('table');
      expect(at('SELECT * FROM t WHERE a = 1 AND |').kind).toBe('column');
    });

    it('expects anything at the very start', () => {
      expect(at('|').kind).toBe('any');
      expect(at('SEL|').kind).toBe('any');
    });

    it('reads the statement the cursor is in, not the whole script', () => {
      expect(at('SELECT * FROM t; SELECT |').kind).toBe('column');
      expect(at('SELECT 1; SELECT * FROM |').kind).toBe('table');
    });
  });

  describe('the word being typed', () => {
    it('reports the prefix and where it starts', () => {
      const context = at('SELECT * FROM cust|');
      expect(context.prefix).toBe('cust');
      expect(context.start).toBe('SELECT * FROM '.length);
    });

    it('reports an empty prefix right after a space', () => {
      const context = at('SELECT * FROM |');
      expect(context.prefix).toBe('');
      expect(context.start).toBe('SELECT * FROM '.length);
    });

    it('reports only the part before the cursor', () => {
      expect(at('SELECT * FROM cu|stomers').prefix).toBe('cu');
    });
  });

  describe('after a dot', () => {
    it('reports the qualifier', () => {
      const context = at('SELECT c.| FROM customers c');
      expect(context.kind).toBe('qualified');
      expect(context.qualifier).toBe('c');
    });

    it('works while a prefix is being typed', () => {
      const context = at('SELECT customers.ema| FROM customers');
      expect(context.kind).toBe('qualified');
      expect(context.qualifier).toBe('customers');
      expect(context.prefix).toBe('ema');
    });

    it('unquotes the qualifier', () => {
      expect(at('SELECT `my table`.| FROM t', 'mysql').qualifier).toBe('my table');
      expect(at('SELECT "My Table".| FROM t', 'postgres').qualifier).toBe('My Table');
    });

    it('also applies after FROM, where a dot means a schema or database', () => {
      const context = at('SELECT * FROM public.|', 'postgres');
      expect(context.kind).toBe('qualified');
      expect(context.qualifier).toBe('public');
    });
  });

  describe('inside text', () => {
    it('offers nothing inside a string', () => {
      const context = at("SELECT 'FROM |'");
      expect(context.inText).toBe(true);
      expect(context.kind).toBe('any');
      expect(context.prefix).toBe('');
    });

    it('offers nothing inside a line or block comment', () => {
      expect(at('SELECT 1 -- FROM |').inText).toBe(true);
      expect(at('SELECT /* FROM | */ 1').inText).toBe(true);
    });

    it('offers nothing in a document that is only a comment', () => {
      // There is no statement to read here, but typing still continues the comment.
      expect(at('-- SEL|').inText).toBe(true);
      expect(at('/* SEL| */').inText).toBe(true);
      expect(at('# SEL|', 'mysql').inText).toBe(true);
    });

    it('is outside again after a closed block comment', () => {
      expect(at('/* note */ |').inText).toBe(false);
    });

    it('is not fooled by a keyword that merely sits inside a string', () => {
      expect(at("SELECT 'FROM x', |").kind).toBe('column');
    });
  });

  describe('tables of the statement', () => {
    it('lists a single table', () => {
      expect(at('SELECT | FROM customers').tables).toEqual([{ name: 'customers' }]);
    });

    it('keeps aliases, with and without AS', () => {
      expect(at('SELECT | FROM customers c').tables).toEqual([{ name: 'customers', alias: 'c' }]);
      expect(at('SELECT | FROM customers AS c').tables).toEqual([
        { name: 'customers', alias: 'c' },
      ]);
    });

    it('lists every table of a join and of a comma list', () => {
      expect(at('SELECT | FROM orders o JOIN customers c ON c.id = o.customer_id').tables).toEqual([
        { name: 'orders', alias: 'o' },
        { name: 'customers', alias: 'c' },
      ]);
      expect(at('SELECT | FROM a, b AS bb').tables).toEqual([
        { name: 'a' },
        { name: 'b', alias: 'bb' },
      ]);
    });

    it('splits qualified names', () => {
      expect(at('SELECT | FROM shop.public.orders o', 'postgres').tables).toEqual([
        { name: 'orders', schema: 'public', database: 'shop', alias: 'o' },
      ]);
      expect(at('SELECT | FROM app.orders', 'mysql').tables).toEqual([
        { name: 'orders', schema: 'app' },
      ]);
    });

    it('does not mistake a following keyword for an alias', () => {
      expect(at('SELECT | FROM customers WHERE id = 1').tables).toEqual([{ name: 'customers' }]);
      expect(at('SELECT | FROM a JOIN b ON a.id = b.id').tables).toEqual([
        { name: 'a' },
        { name: 'b' },
      ]);
      expect(at('SELECT | FROM t ORDER BY a').tables).toEqual([{ name: 't' }]);
    });

    it('handles a clause with nothing after it', () => {
      expect(at('SELECT * FROM |').tables).toEqual([]);
      expect(at('SELECT * FROM WHERE |').tables).toEqual([]);
    });

    it('unquotes table names', () => {
      expect(at('SELECT | FROM `my table` t', 'mysql').tables).toEqual([
        { name: 'my table', alias: 't' },
      ]);
    });
  });

  it('is safe on an empty document', () => {
    expect(completionContextAt('', 0)).toEqual({
      kind: 'any',
      prefix: '',
      start: 0,
      tables: [],
      inText: false,
    });
  });

  it('is safe when the offset is past the text', () => {
    expect(completionContextAt('SELECT 1', 100).kind).toBe('column');
  });
});

describe('tableMentions', () => {
  it('reads mentions from a statement without a cursor', () => {
    expect(tableMentions('UPDATE customers SET name = 1')).toEqual([{ name: 'customers' }]);
    expect(tableMentions('INSERT INTO orders (id) VALUES (1)')).toEqual([{ name: 'orders' }]);
  });

  it('returns nothing when no clause names a table', () => {
    expect(tableMentions('SELECT 1')).toEqual([]);
  });
});

describe('unquote', () => {
  it('removes matching quotes and un-doubles the inner ones', () => {
    expect(unquote('"name"')).toBe('name');
    expect(unquote('`name`')).toBe('name');
    expect(unquote('"we""ird"')).toBe('we"ird');
    expect(unquote('`we``ird`')).toBe('we`ird');
  });

  it('leaves plain and mismatched names alone', () => {
    expect(unquote('name')).toBe('name');
    expect(unquote('"name')).toBe('"name');
    expect(unquote('')).toBe('');
  });
});
