import { describe, expect, it } from 'vitest';
import { textStats, viewOf } from '../../../../../webview/src/apps/result-grid/value-view';

describe('viewOf', () => {
  it('shows NULL as its own kind', () => {
    expect(viewOf(null)).toEqual({ kind: 'null' });
  });

  it('shows plain values as text exactly as the server spelled them', () => {
    expect(viewOf('hi')).toEqual({ kind: 'text', text: 'hi', json: false, valid: false });
    expect(viewOf(5)).toMatchObject({ kind: 'text', text: '5', json: false });
    expect(viewOf(false)).toMatchObject({ text: 'false' });
    expect(viewOf({ kind: 'bigint', text: '9223372036854775807' })).toMatchObject({
      text: '9223372036854775807',
    });
    expect(viewOf({ kind: 'datetime', text: '2024-02-29 10:00:00' })).toMatchObject({
      text: '2024-02-29 10:00:00',
    });
  });

  it('treats a JSON column as JSON and notices when it does not parse', () => {
    expect(viewOf({ kind: 'json', text: '{"a":1}' })).toMatchObject({ json: true, valid: true });
    expect(viewOf({ kind: 'json', text: '{"a":' })).toMatchObject({ json: true, valid: false });
  });

  it('recognizes JSON stored in an ordinary text column', () => {
    expect(viewOf('[1,2,3]')).toMatchObject({ json: true, valid: true });
    expect(viewOf('{"a": 1}')).toMatchObject({ json: true });
  });

  it('does not take text that merely starts like JSON', () => {
    expect(viewOf('{not json}')).toMatchObject({ json: false });
    expect(viewOf('42')).toMatchObject({ json: false });
    expect(viewOf('')).toMatchObject({ kind: 'text', text: '', json: false });
  });

  it('describes binary values by size and preview', () => {
    expect(viewOf({ kind: 'binary', size: 3, preview: '010203' })).toEqual({
      kind: 'binary',
      size: 3,
      preview: '010203',
    });
  });
});

describe('textStats', () => {
  it('counts characters and lines', () => {
    expect(textStats('')).toEqual({ chars: 0, lines: 1 });
    expect(textStats('a\nb\nc')).toEqual({ chars: 5, lines: 3 });
    expect(textStats('a\n')).toEqual({ chars: 2, lines: 2 });
  });
});
