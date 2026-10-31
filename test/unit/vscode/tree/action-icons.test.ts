import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actionIconPath } from '../../../../src/vscode/tree/action-icons';

const ROOT = join(__dirname, '../../../..');

describe('actionIconPath', () => {
  it('points at a file that exists for a known icon', () => {
    const path = actionIconPath('trash');
    expect(path).toEqual(['resources', 'icons', 'actions', 'trash.svg']);
    expect(existsSync(join(ROOT, ...(path ?? [])))).toBe(true);
  });

  it('has none for an icon without a file of our own', () => {
    expect(actionIconPath('rocket')).toBeUndefined();
    expect(actionIconPath('')).toBeUndefined();
  });

  it('covers every icon of the actions list', () => {
    const source = readFileSync(join(ROOT, 'src/vscode/tree/node-actions-ui.ts'), 'utf8');
    const icons = [...source.matchAll(/icon: '([a-z-]+)'/g)].map((match) => match[1] ?? '');
    expect(icons.length).toBeGreaterThan(10);
    for (const icon of icons) {
      expect(actionIconPath(icon), icon).toBeDefined();
    }
  });
});
