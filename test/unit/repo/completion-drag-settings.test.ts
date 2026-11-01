import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS } from '../../../src/vscode/command-ids';
import { ROOT } from '../../helpers/repo';

describe('completion and drag settings (V13.4)', () => {
  const props = (
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
    }
  ).contributes.configuration.properties;

  it('are on by default and named by the code', () => {
    expect(props['datanest.completion.enabled']?.default).toBe(true);
    expect(props['datanest.tree.dragNames']?.default).toBe(true);
    expect(CONFIG_KEYS.completionEnabled).toBe('completion.enabled');
    expect(CONFIG_KEYS.treeDragNames).toBe('tree.dragNames');
  });

  it('are described in English and Russian', () => {
    for (const file of ['package.nls.json', 'package.nls.ru.json']) {
      const nls = JSON.parse(readFileSync(join(ROOT, file), 'utf8')) as Record<string, string>;
      expect(nls['configuration.completion.enabled.description']).toBeTruthy();
      expect(nls['configuration.tree.dragNames.description']).toBeTruthy();
    }
  });
});
