// Every host string passes through vscode.l10n.t() (ARCHITECTURE.md §10); this keeps
// the Russian bundle in step with the code, so no message shows up untranslated.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROOT } from '../../helpers/repo';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

/** The first argument of every `l10n.t('…')` call written as a single-quoted literal. */
function messages(): Set<string> {
  const found = new Set<string>();
  const call = /l10n\.t\(\s*'((?:[^'\\]|\\.)*)'/g;
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(call)) {
      const raw = match[1] ?? '';
      found.add(raw.replace(/\\(.)/g, (_all, char: string) => (char === 'n' ? '\n' : char)));
    }
  }
  return found;
}

const bundle = JSON.parse(
  readFileSync(join(ROOT, 'l10n', 'bundle.l10n.ru.json'), 'utf8'),
) as Record<string, string>;

describe('l10n bundle', () => {
  const used = messages();

  it('finds the messages of the extension', () => {
    expect(used.size).toBeGreaterThan(50);
    expect(used.has('Tables')).toBe(true);
  });

  it('translates every message the code shows', () => {
    expect([...used].filter((message) => !(message in bundle))).toEqual([]);
  });

  it('has no translations the code no longer uses', () => {
    expect(Object.keys(bundle).filter((key) => !used.has(key))).toEqual([]);
  });

  it('keeps every {n} placeholder in the translation', () => {
    for (const [key, value] of Object.entries(bundle)) {
      const placeholders = (text: string) => (text.match(/\{\d+\}/g) ?? []).sort();
      expect(placeholders(value), key).toEqual(placeholders(key));
    }
  });
});
