import { describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import {
  NOTEBOOK_VERSION,
  parseNotebook,
  serializeNotebook,
} from '../../../src/services/notebook-file';

describe('parseNotebook', () => {
  it('reads cells and the place of a notebook', () => {
    const file = parseNotebook(
      JSON.stringify({
        version: 1,
        connection: 'staging',
        connectionName: 'Staging DB',
        database: 'shop',
        cells: [
          { kind: 'markdown', source: ['# Title', 'text'] },
          { kind: 'sql', source: ['SELECT 1;'] },
        ],
      }),
    );
    expect(file).toEqual({
      connection: 'staging',
      connectionName: 'Staging DB',
      database: 'shop',
      cells: [
        { kind: 'markdown', source: '# Title\ntext' },
        { kind: 'sql', source: 'SELECT 1;' },
      ],
    });
  });

  it('takes an empty file as an empty notebook', () => {
    expect(parseNotebook('')).toEqual({ cells: [] });
    expect(parseNotebook(' \n')).toEqual({ cells: [] });
  });

  it('accepts a cell’s source as one string and an unknown kind as SQL', () => {
    expect(parseNotebook('{"cells":[{"kind":"python","source":"a\\nb"}]}').cells).toEqual([
      { kind: 'sql', source: 'a\nb' },
    ]);
  });

  it('gives a cell without source an empty text and skips what is not a cell', () => {
    expect(parseNotebook('{"cells":[{"kind":"sql"},5,null,"x"]}').cells).toEqual([
      { kind: 'sql', source: '' },
    ]);
  });

  it('leaves out the lines of a source that are not text', () => {
    expect(parseNotebook('{"cells":[{"source":["a",1,"b"]}]}').cells[0]?.source).toBe('a\nb');
  });

  it('reads a file that starts with a byte order mark', () => {
    expect(parseNotebook('﻿{"cells":[]}')).toEqual({ cells: [] });
  });

  it('ignores a place that is not text', () => {
    expect(parseNotebook('{"connection":5,"database":"","cells":[]}')).toEqual({ cells: [] });
  });

  it('refuses text that is not JSON, and JSON that is not a notebook', () => {
    for (const text of ['{', 'SELECT 1', '[]', '5', 'null', '{"cells":{}}']) {
      expect(() => parseNotebook(text), text).toThrow(DbError);
    }
  });

  it('refuses a notebook of a newer version, and says so', () => {
    expect(() => parseNotebook(`{"version":${NOTEBOOK_VERSION + 1},"cells":[]}`)).toThrow(
      /newer DataNest/u,
    );
  });
});

describe('serializeNotebook', () => {
  it('writes the cells as lines, so a change is a small diff', () => {
    const text = serializeNotebook({
      connection: 'staging',
      cells: [{ kind: 'sql', source: 'SELECT 1;\nSELECT 2;' }],
    });
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      version: 1,
      connection: 'staging',
      cells: [{ kind: 'sql', source: ['SELECT 1;', 'SELECT 2;'] }],
    });
    expect(text).toContain('"SELECT 1;",\n');
  });

  it('writes an empty cell as an empty list and leaves out an unset place', () => {
    const parsed = JSON.parse(serializeNotebook({ cells: [{ kind: 'sql', source: '' }] })) as {
      cells: { source: string[] }[];
    };
    expect(parsed).toEqual({ version: 1, cells: [{ kind: 'sql', source: [] }] });
  });

  it('splits CRLF text into lines', () => {
    const parsed = parseNotebook(serializeNotebook({ cells: [{ kind: 'sql', source: 'a\r\nb' }] }));
    expect(parsed.cells[0]?.source).toBe('a\nb');
  });

  it('round-trips a notebook', () => {
    const notebook = {
      connection: 'c',
      connectionName: 'Name',
      database: 'd',
      cells: [
        { kind: 'markdown' as const, source: '# T\n\ntext' },
        { kind: 'sql' as const, source: 'SELECT "a"\nFROM t' },
        { kind: 'sql' as const, source: '' },
      ],
    };
    expect(parseNotebook(serializeNotebook(notebook))).toEqual(notebook);
  });
});
