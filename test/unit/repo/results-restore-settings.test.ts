// The two settings of the restored result tabs (V13.12) are declared in package.json and
// read in code under the same names, with texts in both languages; the default of the
// automatic run stays off, since running a query on its own is the user's call.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONFIG_KEYS, CONFIG_SECTION } from '../../../src/vscode/command-ids';
import { ROOT } from '../../helpers/repo';

interface Setting {
  type: string;
  default: unknown;
  markdownDescription: string;
}

function json(file: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
}

const manifest = json('package.json') as {
  contributes: { configuration: { properties: Record<string, Setting> } };
};
const properties = manifest.contributes.configuration.properties;
const restore = properties[`${CONFIG_SECTION}.${CONFIG_KEYS.resultsRestore}`];
const restoreRun = properties[`${CONFIG_SECTION}.${CONFIG_KEYS.resultsRestoreRun}`];

describe('settings of restored result tabs', () => {
  it('are booleans under the names the code reads', () => {
    expect(CONFIG_KEYS.resultsRestore).toBe('results.restore');
    expect(CONFIG_KEYS.resultsRestoreRun).toBe('results.restoreRun');
    expect(restore?.type).toBe('boolean');
    expect(restoreRun?.type).toBe('boolean');
  });

  it('bring the tabs back by default, but never run anything on their own by default', () => {
    expect(restore?.default).toBe(true);
    expect(restoreRun?.default).toBe(false);
  });

  it('have an English and a Russian text', () => {
    for (const file of ['package.nls.json', 'package.nls.ru.json']) {
      const texts = json(file) as Record<string, string>;
      for (const setting of [restore, restoreRun]) {
        const key = (setting?.markdownDescription ?? '').replaceAll('%', '');
        expect(texts[key], `${file}: ${key}`).toBeTruthy();
      }
    }
  });

  it('are described in the settings guide', () => {
    const guide = readFileSync(join(ROOT, 'docs/guide/settings.md'), 'utf8');
    expect(guide).toContain('`datanest.results.restore`');
    expect(guide).toContain('`datanest.results.restoreRun`');
  });
});
