import { describe, expect, it } from 'vitest';
import {
  displayOf,
  formatBytes,
  MAX_CELL_CHARS,
} from '../../../../../webview/src/apps/result-grid/cells';

describe('displayOf', () => {
  it('shows NULL as NULL, marked so it cannot be mistaken for text', () => {
    const cell = displayOf(null);
    expect(cell).toEqual({
      text: 'NULL',
      isNull: true,
      numeric: false,
      truncated: false,
      flattened: false,
    });
  });

  it('does not mark the string "NULL" as a null', () => {
    const cell = displayOf('NULL');
    expect(cell.text).toBe('NULL');
    expect(cell.isNull).toBe(false);
  });

  it('right-aligns numbers and keeps their exact text', () => {
    expect(displayOf(42)).toMatchObject({ text: '42', numeric: true });
    expect(displayOf(-1.5)).toMatchObject({ text: '-1.5', numeric: true });
    expect(displayOf({ kind: 'bigint', text: '9223372036854775807' })).toMatchObject({
      text: '9223372036854775807',
      numeric: true,
    });
    expect(displayOf({ kind: 'decimal', text: '1.50' })).toMatchObject({
      text: '1.50',
      numeric: true,
    });
  });

  it('shows booleans as words, not numbers', () => {
    expect(displayOf(true)).toMatchObject({ text: 'true', numeric: false });
    expect(displayOf(false)).toMatchObject({ text: 'false', numeric: false });
  });

  it('shows dates and JSON as the server spelled them', () => {
    expect(displayOf({ kind: 'datetime', text: '2024-12-31 23:59:59.123' }).text).toBe(
      '2024-12-31 23:59:59.123',
    );
    expect(displayOf({ kind: 'json', text: '{"a":1}' }).text).toBe('{"a":1}');
  });

  it('flattens newlines and tabs so a cell stays one line, and says it did', () => {
    const cell = displayOf('line one\nline two\tend');
    expect(cell.text).toBe('line one line two end');
    expect(cell.flattened).toBe(true);
    // Nothing was cut: the whole value is on screen, just on one line.
    expect(cell.truncated).toBe(false);
  });

  it('does not claim to have flattened single-line text', () => {
    expect(displayOf('plain text').flattened).toBe(false);
  });

  it('cuts very long text and says it was cut', () => {
    const cell = displayOf('x'.repeat(MAX_CELL_CHARS + 50));
    expect(cell.text).toHaveLength(MAX_CELL_CHARS + 1);
    expect(cell.text.endsWith('…')).toBe(true);
    expect(cell.truncated).toBe(true);
  });

  it('keeps text at the limit untouched', () => {
    const cell = displayOf('x'.repeat(MAX_CELL_CHARS));
    expect(cell.text).toHaveLength(MAX_CELL_CHARS);
    expect(cell.truncated).toBe(false);
  });

  it('shows the size and a hex preview of binary data', () => {
    expect(displayOf({ kind: 'binary', size: 4, preview: 'deadbeef' }).text).toBe('4 B · deadbeef');
    expect(displayOf({ kind: 'binary', size: 2048, preview: 'ab' }).text).toBe('2.0 KB · ab');
  });

  it('cuts a long hex preview', () => {
    const cell = displayOf({ kind: 'binary', size: 1000, preview: 'ab'.repeat(100) });
    expect(cell.text.endsWith('…')).toBe(true);
    expect(cell.truncated).toBe(true);
  });

  it('shows an empty string as empty, not as NULL', () => {
    expect(displayOf('')).toEqual({
      text: '',
      isNull: false,
      numeric: false,
      truncated: false,
      flattened: false,
    });
  });
});

describe('formatBytes', () => {
  it('uses bytes, kilobytes and megabytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
