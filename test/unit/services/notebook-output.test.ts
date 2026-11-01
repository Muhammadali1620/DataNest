import { describe, expect, it } from 'vitest';
import {
  doneLine,
  escapeHtml,
  footerLine,
  NOTEBOOK_CELL_LIMIT,
  NOTEBOOK_ROW_LIMIT,
  tableOutput,
} from '../../../src/services/notebook-output';
import type { CellValue } from '../../../src/shared/cell-value';

const columns = [
  { name: 'id', dataType: 'int' },
  { name: 'name', dataType: 'text' },
];

function summary(rowCount: number, extra: { truncated?: boolean } = {}) {
  return { columns, rowCount, truncated: extra.truncated ?? false, durationMs: 7 };
}

describe('escapeHtml', () => {
  it('escapes everything that could open a tag or leave an attribute', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;',
    );
  });
});

describe('tableOutput', () => {
  it('draws the columns and rows as a table, NULL in italics', () => {
    const { html } = tableOutput(summary(2), [
      [1, 'apple'],
      [2, null],
    ]);
    expect(html).toContain('<th');
    expect(html).toContain('>id</th>');
    expect(html).toContain('>apple</td>');
    expect(html).toMatch(/<i[^>]*>NULL<\/i>/u);
    expect(html).toContain('2 rows');
  });

  it('never lets a value become markup', () => {
    const { html } = tableOutput({ ...summary(1), columns: [{ name: '<b>', dataType: 'text' }] }, [
      ['<script>alert(1)</script>'],
    ]);
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('gives the same rows as plain text, tabs and line breaks turned into spaces', () => {
    const { text } = tableOutput(summary(1), [[1, 'a\tb\nc']]);
    expect(text.split('\n')[0]).toBe('id\tname');
    expect(text.split('\n')[1]).toBe('1\ta b c');
  });

  it('shows at most the row limit and says how many were left out', () => {
    const rows: CellValue[][] = Array.from({ length: NOTEBOOK_ROW_LIMIT + 10 }, (_, i) => [i, 'x']);
    const { html, text } = tableOutput(summary(rows.length), rows);
    expect(html.match(/<tr>/gu)).toHaveLength(NOTEBOOK_ROW_LIMIT + 1);
    expect(text).toContain(`first ${NOTEBOOK_ROW_LIMIT} shown`);
  });

  it('cuts a huge value', () => {
    const { text } = tableOutput(summary(1), [[1, 'x'.repeat(NOTEBOOK_CELL_LIMIT + 50)]]);
    expect(text.split('\n')[1]?.endsWith('…')).toBe(true);
    expect(text.length).toBeLessThan(NOTEBOOK_CELL_LIMIT + 100);
  });

  it('draws the head of a result without rows', () => {
    const { html, text } = tableOutput(summary(0), []);
    expect(html).toContain('>name</th>');
    expect(text.startsWith('id\tname\n0 rows')).toBe(true);
  });

  it('tolerates a short row', () => {
    const { text } = tableOutput(summary(1), [[1]]);
    expect(text.split('\n')[1]).toBe('1\tNULL');
  });
});

describe('footerLine', () => {
  it('says when the row limit of the server cut the result', () => {
    expect(footerLine(summary(5, { truncated: true }), 5)).toContain('row limit');
  });

  it('names the time', () => {
    expect(footerLine(summary(1), 1)).toContain('7 ms');
  });
});

describe('doneLine', () => {
  it('names the rows a statement changed', () => {
    expect(doneLine({ affectedRows: 3, durationMs: 4 })).toBe('3 rows affected · 4 ms');
  });

  it('just says it is done when the server did not say', () => {
    expect(doneLine({ durationMs: 4 })).toBe('Done · 4 ms');
  });
});
