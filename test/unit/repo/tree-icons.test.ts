import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../helpers/repo';

// The tree draws tables and views with its own coloured icons (V12.1); a missing or
// broken file would leave a blank space before every table name.
describe('tree icons', () => {
  it.each(['table.svg', 'view.svg'])('ships %s as a 16 px SVG', (file) => {
    const path = join(ROOT, 'resources/icons/tree', file);
    expect(existsSync(path)).toBe(true);
    const svg = readFileSync(path, 'utf8');
    expect(svg).toMatch(/^<svg [^>]*width="16"[^>]*height="16"/u);
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg.trim().endsWith('</svg>')).toBe(true);
  });

  it('are not the editor table glyph: a table and a view differ', () => {
    const table = readFileSync(join(ROOT, 'resources/icons/tree/table.svg'), 'utf8');
    const view = readFileSync(join(ROOT, 'resources/icons/tree/view.svg'), 'utf8');
    expect(table).not.toBe(view);
  });
});
