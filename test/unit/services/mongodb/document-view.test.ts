import { describe, expect, it } from 'vitest';
import { parseDocument } from '../../../../src/core/mongo/shell-parse';
import { doc, int32, str } from '../../../../src/core/mongo/value';
import {
  columnsOf,
  documentsText,
  documentText,
  pageView,
  rowOf,
} from '../../../../src/services/mongodb/document-view';
import { MAX_DOCUMENT_TEXT } from '../../../../src/shared/protocols/mongo-documents';

describe('columnsOf (V7.6)', () => {
  it('puts _id first, then every field as it first appears', () => {
    expect(
      columnsOf([
        parseDocument('{ name: "a", _id: 1 }'),
        parseDocument('{ _id: 2, city: "b", name: "c" }'),
        parseDocument('{ "12": 3 }'),
      ]),
    ).toEqual(['_id', 'name', 'city', '12']);
  });

  it('has no _id column when no document has one', () => {
    expect(columnsOf([parseDocument('{ n: 1 }')])).toEqual(['n']);
    expect(columnsOf([])).toEqual([]);
  });
});

describe('rowOf and pageView (V7.6)', () => {
  it('shows each value as a short cell with its type, and missing fields as null', () => {
    const { columns, rows } = pageView([
      {
        document: parseDocument(
          '{ _id: ObjectId("65a1b2c3d4e5f60718293a4b"), total: NumberDecimal("1.50"), tags: ["a"], nested: { a: 1 }, empty: {}, none: [] }',
        ),
        size: 90,
      },
      { document: parseDocument('{ _id: 2, extra: "x\\ny" }'), size: 20 },
    ]);
    expect(columns).toEqual(['_id', 'total', 'tags', 'nested', 'empty', 'none', 'extra']);
    expect(rows[0]?.id).toBe('ObjectId("65a1b2c3d4e5f60718293a4b")');
    expect(rows[0]?.cells).toEqual([
      { text: 'ObjectId("65a1b2c3d4e5f60718293a4b")', type: 'objectId' },
      { text: 'NumberDecimal("1.50")', type: 'decimal' },
      { text: '["a"]', type: 'array' },
      { text: '{ a: 1 }', type: 'document' },
      { text: '{}', type: 'document' },
      { text: '[]', type: 'array' },
      null,
    ]);
    expect(rows[1]?.cells.at(-1)).toEqual({ text: 'x y', type: 'string' });
    expect(rows[1]).toMatchObject({ index: 1, size: 20, truncated: false });
    expect(rows[1]?.text).toBe('{\n  _id: 2,\n  extra: "x\\ny"\n}');
  });

  it('cuts a long cell, and shows the first value of a repeated name', () => {
    const row = rowOf(
      {
        document: doc([
          ['a', str('x'.repeat(500))],
          ['a', int32(2)],
        ]),
        size: 1,
      },
      0,
      ['a'],
    );
    expect(row.cells[0]?.text).toHaveLength(200);
    expect(row.cells[0]?.text.endsWith('…')).toBe(true);
    expect(row.id).toBeUndefined();
  });

  it('cuts the text of a huge document and says so', () => {
    const big = documentText(doc([['text', str('y'.repeat(MAX_DOCUMENT_TEXT + 10))]]));
    expect(big.truncated).toBe(true);
    expect(big.text.length).toBeLessThan(MAX_DOCUMENT_TEXT + 10);
    expect(documentText(doc([])).truncated).toBe(false);
  });
});

describe('documentsText (V7.6)', () => {
  it('writes one document as it is, several as an array', () => {
    expect(documentsText([parseDocument('{ a: 1 }')])).toBe('{\n  a: 1\n}');
    expect(documentsText([parseDocument('{ a: 1 }'), parseDocument('{ b: 2 }')])).toBe(
      '[\n  {\n    a: 1\n  },\n  {\n    b: 2\n  }\n]',
    );
    expect(documentsText([])).toBe('[\n\n]');
  });
});
