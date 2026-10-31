// A cell's value as a file and back (V10.2.4): the value panel saves a BLOB, a long
// text or a JSON document to disk, and loads a file into a cell of an editable result.

import { binaryValue } from '../drivers/common/values';
import { MAX_BINARY_VIEW_BYTES, retainedBytes } from '../shared/binary-bytes';
import { type InputKind, type InputProblem, parseCellInput } from '../shared/cell-input';
import { cellText } from '../shared/cell-text';
import type { CellValue } from '../shared/cell-value';

/** The largest file loaded into a cell: as much as a binary value keeps whole. */
export const MAX_CELL_FILE_BYTES = MAX_BINARY_VIEW_BYTES;

export type CellFileProblem =
  /** NULL has nothing to save. */
  | 'no-value'
  /** A binary value larger than the host keeps; only its preview is known. */
  | 'too-large';

/** What a file of the value holds: the bytes of a binary, the UTF-8 text of the rest. */
export function cellFileBytes(cell: CellValue | undefined): Uint8Array | CellFileProblem {
  if (cell === undefined || cell === null) {
    return 'no-value';
  }
  if (typeof cell === 'object' && cell.kind === 'binary') {
    const bytes = retainedBytes(cell);
    if (bytes !== undefined) {
      return bytes;
    }
    // A preview that holds every byte is the value itself.
    return cell.preview.length >= cell.size * 2 ? Buffer.from(cell.preview, 'hex') : 'too-large';
  }
  return Buffer.from(cellText(cell), 'utf8');
}

/** A file name from a column name: what file systems refuse becomes `_`. */
export function fileNameFor(column: string): string {
  // Characters below a space are refused by Windows too; they are dropped like the rest.
  const printable = Array.from(column, (char) => (char < ' ' ? '_' : char)).join('');
  const name = printable
    .replace(/[\\/:*?"<>|]/gu, '_')
    .trim()
    .slice(0, 100);
  return name === '' || /^\.+$/u.test(name) ? 'value' : name;
}

/** The usual extension for a file of the value, so the save dialog suggests one. */
export function cellFileExtension(cell: CellValue | undefined): string {
  if (typeof cell === 'object' && cell !== null) {
    return cell.kind === 'binary' ? 'bin' : cell.kind === 'json' ? 'json' : 'txt';
  }
  return 'txt';
}

export type FileValue =
  | { readonly ok: true; readonly value: CellValue }
  | {
      readonly ok: false;
      readonly error: 'too-large' | 'not-text' | 'read-only-column' | InputProblem;
    };

const UTF8 = new TextDecoder('utf-8', { fatal: true });

/**
 * A file as the new value of a column: the bytes themselves for a binary column, the
 * text for a text or JSON column (which must be UTF-8, and valid JSON for JSON). Other
 * kinds of columns are typed, not loaded.
 */
export function fileCellValue(kind: InputKind, bytes: Uint8Array): FileValue {
  if (bytes.byteLength > MAX_CELL_FILE_BYTES) {
    return { ok: false, error: 'too-large' };
  }
  if (kind === 'binary') {
    return { ok: true, value: binaryValue(bytes) };
  }
  if (kind !== 'text' && kind !== 'json') {
    return { ok: false, error: 'read-only-column' };
  }
  let text: string;
  try {
    text = UTF8.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      return { ok: false, error: 'not-text' };
    }
    throw error;
  }
  // A byte order mark is the editor's, not part of the value.
  const parsed = parseCellInput(kind, text.startsWith('﻿') ? text.slice(1) : text);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, error: parsed.problem };
}
