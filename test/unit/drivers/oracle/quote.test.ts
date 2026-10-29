import { describe, expect, it } from 'vitest';
import {
  MAX_IDENTIFIER_BYTES,
  quoteIdentifier,
  quoteString,
  quoteTable,
  quoteText,
  TEXT_PIECE,
} from '../../../../src/drivers/oracle/quote';

describe('quoteIdentifier', () => {
  it('puts a name in double quotes and keeps its case', () => {
    expect(quoteIdentifier('ORDERS')).toBe('"ORDERS"');
    expect(quoteIdentifier('orders')).toBe('"orders"');
    expect(quoteIdentifier('with space')).toBe('"with space"');
    expect(quoteIdentifier("it's")).toBe('"it\'s"');
    expect(quoteIdentifier('Заказы')).toBe('"Заказы"');
  });

  it('refuses an empty name', () => {
    expect(() => quoteIdentifier('')).toThrow(/empty/u);
  });

  it('refuses a name with NUL or a double quote, which Oracle cannot escape', () => {
    expect(() => quoteIdentifier('a\u0000b')).toThrow(/NUL/u);
    expect(() => quoteIdentifier('a"b')).toThrow(/double quote/u);
    expect(() => quoteIdentifier('"')).toThrow(/double quote/u);
  });

  it('knows the longest identifier of Oracle 12.2 and newer', () => {
    expect(MAX_IDENTIFIER_BYTES).toBe(128);
  });
});

describe('quoteTable', () => {
  it('names a table with its schema when one is given', () => {
    expect(quoteTable({ schema: 'APP', name: 'ORDERS' })).toBe('"APP"."ORDERS"');
    expect(quoteTable({ name: 'ORDERS' })).toBe('"ORDERS"');
  });

  it('never writes the database, which is the service of the connection', () => {
    expect(quoteTable({ database: 'FREEPDB1', schema: 'APP', name: 'T' })).toBe('"APP"."T"');
    expect(quoteTable({ database: 'FREEPDB1', name: 'T' })).toBe('"T"');
  });

  it('refuses a bad schema or table name', () => {
    expect(() => quoteTable({ schema: '', name: 'T' })).toThrow(/empty/u);
    expect(() => quoteTable({ schema: 'A', name: 'x"y' })).toThrow(/double quote/u);
  });
});

describe('quoteString', () => {
  it('doubles single quotes', () => {
    expect(quoteString("O'Brien")).toBe("'O''Brien'");
    expect(quoteString("''")).toBe("''''''");
    expect(quoteString('')).toBe("''");
  });

  it('keeps plain ASCII text a plain literal', () => {
    expect(quoteString('hello, world ~')).toBe("'hello, world ~'");
    expect(quoteString('line\nbreak\ttab')).toBe("'line\nbreak\ttab'");
  });

  it('writes N… only for text outside ASCII', () => {
    expect(quoteString('日本語')).toBe("N'日本語'");
    expect(quoteString("café's")).toBe("N'café''s'");
    expect(quoteString('🚀')).toBe("N'🚀'");
    expect(quoteString('\u007f')).toBe("'\u007f'");
    expect(quoteString('\u0080')).toBe("N'\u0080'");
  });
});

describe('quoteText', () => {
  it('writes text that fits one literal as a plain string', () => {
    expect(TEXT_PIECE).toBe(1000);
    expect(quoteText("it's")).toBe("'it''s'");
    expect(quoteText('')).toBe("''");
    const full = 'a'.repeat(TEXT_PIECE);
    expect(quoteText(full)).toBe(`'${full}'`);
    expect(quoteText('я'.repeat(TEXT_PIECE))).toBe(`N'${'я'.repeat(TEXT_PIECE)}'`);
  });

  it('joins longer text from CLOB pieces of 1000 characters', () => {
    const text = `${'a'.repeat(TEXT_PIECE)}${'b'.repeat(TEXT_PIECE)}c`;
    expect(quoteText(text)).toBe(
      `TO_CLOB('${'a'.repeat(TEXT_PIECE)}') || TO_CLOB('${'b'.repeat(TEXT_PIECE)}') || TO_CLOB('c')`,
    );
  });

  it('quotes each piece by itself: quotes doubled, N… only where a piece needs it', () => {
    const text = `${"'".repeat(TEXT_PIECE)}ж`;
    expect(quoteText(text)).toBe(`TO_CLOB('${"''".repeat(TEXT_PIECE)}') || TO_CLOB(N'ж')`);
  });

  it('never cuts a surrogate pair between pieces', () => {
    const text = `${'a'.repeat(TEXT_PIECE - 1)}🚀${'b'.repeat(5)}`;
    expect(text.length).toBe(TEXT_PIECE + 6);
    expect(quoteText(text)).toBe(`TO_CLOB('${'a'.repeat(TEXT_PIECE - 1)}') || TO_CLOB(N'🚀bbbbb')`);
  });

  it('keeps a pair that ends a piece exactly in that piece', () => {
    const text = `${'a'.repeat(TEXT_PIECE - 2)}🚀b`;
    expect(quoteText(text)).toBe(`TO_CLOB(N'${'a'.repeat(TEXT_PIECE - 2)}🚀') || TO_CLOB('b')`);
  });

  it('keeps every character of a long text of emoji', () => {
    const text = '🚀'.repeat(TEXT_PIECE);
    const pieces = quoteText(text).split(' || ');
    expect(pieces).toHaveLength(2);
    const inner = pieces.map((piece) => /^TO_CLOB\(N'(.*)'\)$/su.exec(piece)?.[1] ?? '');
    expect(inner.join('')).toBe(text);
    expect(inner.every((piece) => piece.length <= TEXT_PIECE)).toBe(true);
  });
});
