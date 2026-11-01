// The two settings of the result grid's look (V13.3) are declared in package.json and read
// in code from the same names; this keeps the manifest, the shared limits and the
// translations from drifting apart.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COLUMN_LIMIT,
  lookFromSettings,
  MAX_COLUMN_LIMIT,
  MIN_COLUMN_LIMIT,
  ROW_DENSITIES,
} from '../../../src/shared/results-look';
import { CONFIG_KEYS, CONFIG_SECTION } from '../../../src/vscode/command-ids';
import { ROOT } from '../../helpers/repo';

interface Setting {
  type: string;
  default: unknown;
  enum?: string[];
  enumDescriptions?: string[];
  minimum?: number;
  maximum?: number;
  markdownDescription: string;
}

function json(file: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
}

const manifest = json('package.json') as {
  contributes: { configuration: { properties: Record<string, Setting> } };
};
const properties = manifest.contributes.configuration.properties;
const rowHeight = properties[`${CONFIG_SECTION}.${CONFIG_KEYS.resultsRowHeight}`];
const maxWidth = properties[`${CONFIG_SECTION}.${CONFIG_KEYS.resultsMaxColumnWidth}`];

describe('result grid settings', () => {
  it('declare the row height with exactly the densities the code knows', () => {
    expect(rowHeight?.type).toBe('string');
    expect(rowHeight?.enum).toEqual([...ROW_DENSITIES]);
    expect(rowHeight?.enumDescriptions).toHaveLength(ROW_DENSITIES.length);
  });

  it('declare the column limit with the range the code clamps to', () => {
    expect(maxWidth?.type).toBe('integer');
    expect(maxWidth?.minimum).toBe(MIN_COLUMN_LIMIT);
    expect(maxWidth?.maximum).toBe(MAX_COLUMN_LIMIT);
  });

  it('default to the look the grid always had', () => {
    expect(maxWidth?.default).toBe(DEFAULT_COLUMN_LIMIT);
    expect(lookFromSettings(rowHeight?.default, maxWidth?.default)).toEqual({
      rowHeight: 32,
      maxColumnWidth: 420,
    });
  });

  it('accept every value the manifest allows', () => {
    for (const density of rowHeight?.enum ?? []) {
      const look = lookFromSettings(density, maxWidth?.default);
      expect(look.rowHeight).toBeGreaterThanOrEqual(20);
      expect(look.rowHeight).toBeLessThanOrEqual(64);
    }
    for (const value of [maxWidth?.minimum, maxWidth?.maximum]) {
      expect(lookFromSettings('normal', value).maxColumnWidth).toBe(value);
    }
  });

  it('have an English and a Russian text for the setting and each of its choices', () => {
    const keys = [
      ...[rowHeight?.markdownDescription, maxWidth?.markdownDescription],
      ...(rowHeight?.enumDescriptions ?? []),
    ].map((text) => (text ?? '').replaceAll('%', ''));
    expect(keys).toHaveLength(5);
    for (const file of ['package.nls.json', 'package.nls.ru.json']) {
      const texts = json(file) as Record<string, string>;
      for (const key of keys) {
        expect(texts[key], `${file}: ${key}`).toBeTruthy();
      }
    }
  });
});
