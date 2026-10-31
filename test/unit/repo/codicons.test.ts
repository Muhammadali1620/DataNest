import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CODICONS } from '../../../webview/src/lib/codicons';
import { ROOT } from '../../helpers/repo';

// The pages name icons by the package's names; a wrong code point would draw another icon.
describe('codicon map', () => {
  const csv = readFileSync(join(ROOT, 'node_modules/@vscode/codicons/dist/codicon.csv'), 'utf8');
  const points = new Map(
    csv
      .split('\n')
      .slice(1)
      .filter((line) => line.trim() !== '')
      .map((line) => {
        const [name = '', , unicode = ''] = line.split(',');
        return [name, Number.parseInt(unicode, 16)] as const;
      }),
  );

  it('has the code point of the package for every icon', () => {
    for (const [name, point] of Object.entries(CODICONS)) {
      expect(points.get(name), name).toBe(point);
    }
  });

  it('lists a useful set and no icon twice under one name', () => {
    expect(Object.keys(CODICONS).length).toBeGreaterThan(100);
  });

  it('ships the font and its licence notice in the extension', () => {
    const ignore = readFileSync(join(ROOT, '.vscodeignore'), 'utf8');
    expect(ignore).toContain('!dist/**/*.ttf');
    const notice = readFileSync(join(ROOT, 'resources/licenses/codicons.txt'), 'utf8');
    expect(notice).toContain('Creative Commons Attribution 4.0');
    expect(notice).toContain('@vscode/codicons');
  });
});
