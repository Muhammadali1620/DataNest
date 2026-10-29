// How the documents page shows a page of documents (V7.6): the top-level fields as
// columns, each value as a short cell, each document as text in the shell's syntax. The
// page gets only this; the documents themselves stay in the host (D89).

import { formatPretty, previewValue } from '../../core/mongo/shell-format';
import type { MongoDocument, MongoValue } from '../../core/mongo/value';
import type { MongoRawDocument } from '../../drivers/mongo-driver';
import {
  MAX_CELL_TEXT,
  MAX_DOCUMENT_TEXT,
  type MongoDocumentRow,
} from '../../shared/protocols/mongo-documents';

/** `_id` first, then every other top-level field in the order it first appears. */
export function columnsOf(documents: readonly MongoDocument[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  const hasId = documents.some((document) => document.fields.some(([name]) => name === '_id'));
  if (hasId) {
    seen.add('_id');
    columns.push('_id');
  }
  for (const document of documents) {
    for (const [name] of document.fields) {
      if (!seen.has(name)) {
        seen.add(name);
        columns.push(name);
      }
    }
  }
  return columns;
}

/** A nested document or array says how big it is instead of showing everything. */
function cellText(value: MongoValue): string {
  if (value.type === 'document') {
    return value.fields.length === 0 ? '{}' : previewValue(value, MAX_CELL_TEXT);
  }
  if (value.type === 'array') {
    return value.items.length === 0 ? '[]' : previewValue(value, MAX_CELL_TEXT);
  }
  return previewValue(value, MAX_CELL_TEXT);
}

/** The text of a document, cut at MAX_DOCUMENT_TEXT characters. */
export function documentText(document: MongoDocument): { text: string; truncated: boolean } {
  const text = formatPretty(document);
  if (text.length <= MAX_DOCUMENT_TEXT) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, MAX_DOCUMENT_TEXT)}\n…`, truncated: true };
}

export function rowOf(
  raw: MongoRawDocument,
  index: number,
  columns: readonly string[],
): MongoDocumentRow {
  const values = new Map<string, MongoValue>();
  for (const [name, value] of raw.document.fields) {
    // A name that repeats shows its first value, as the server reads it.
    if (!values.has(name)) {
      values.set(name, value);
    }
  }
  const id = values.get('_id');
  const { text, truncated } = documentText(raw.document);
  return {
    index,
    ...(id === undefined ? {} : { id: previewValue(id, MAX_CELL_TEXT) }),
    cells: columns.map((column) => {
      const value = values.get(column);
      return value === undefined ? null : { text: cellText(value), type: value.type };
    }),
    text,
    truncated,
    size: raw.size,
  };
}

/** Rows of a page and their columns. */
export function pageView(documents: readonly MongoRawDocument[]): {
  columns: string[];
  rows: MongoDocumentRow[];
} {
  const columns = columnsOf(documents.map((raw) => raw.document));
  return { columns, rows: documents.map((raw, index) => rowOf(raw, index, columns)) };
}

/** Documents as text one after another, for the clipboard. */
export function documentsText(documents: readonly MongoDocument[]): string {
  return documents.length === 1
    ? formatPretty(documents[0] ?? { type: 'document', fields: [] })
    : `[\n${documents.map((document) => formatPretty(document).replace(/^/gm, '  ')).join(',\n')}\n]`;
}
