import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { formatMessage, msg, setTranslator, type Translator } from '../../../src/core/user-message';
import { ROOT } from '../../helpers/repo';

afterEach(() => {
  setTranslator(undefined);
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

describe('formatMessage', () => {
  it('puts values into their places', () => {
    expect(formatMessage('{0} of {1}', [3, 'ten'])).toBe('3 of ten');
  });

  it('uses a value as many times as its place appears', () => {
    expect(formatMessage('{0}, {0} and {1}', ['a', true])).toBe('a, a and true');
  });

  it('leaves a place without a value as written', () => {
    expect(formatMessage('{0} and {2}', ['a'])).toBe('a and {2}');
  });

  it('leaves braces that are not places alone', () => {
    expect(formatMessage('Expected a document in braces: { … }', [])).toBe(
      'Expected a document in braces: { … }',
    );
    expect(formatMessage('{name} {0}', ['x'])).toBe('{name} x');
  });

  it('does not read places inside the values', () => {
    expect(formatMessage('{0} {1}', ['{1}', 'b'])).toBe('{1} b');
  });
});

describe('msg', () => {
  it('is English with no translator', () => {
    expect(msg('Connection "{0}" does not exist', 'prod')).toBe('Connection "prod" does not exist');
  });

  it('asks the translator with the template and the values', () => {
    const calls: [string, readonly unknown[]][] = [];
    setTranslator((template, args) => {
      calls.push([template, args]);
      return `ru:${formatMessage(template, args)}`;
    });
    expect(msg('Timed out')).toBe('ru:Timed out');
    expect(msg('Excel holds at most {0} columns', 16384)).toBe(
      'ru:Excel holds at most 16384 columns',
    );
    expect(calls).toEqual([
      ['Timed out', []],
      ['Excel holds at most {0} columns', [16384]],
    ]);
  });

  it('falls back to English when the translator fails', () => {
    setTranslator(() => {
      throw new Error('no bundle');
    });
    expect(msg('{0} rows', 5)).toBe('5 rows');
  });

  it('stops translating once the translator is removed', () => {
    setTranslator(() => 'translated');
    setTranslator(undefined);
    expect(msg('Timed out')).toBe('Timed out');
  });

  it('finds the translator through the global symbol registry, as other bundles do', () => {
    // Every driver bundle has its own copy of this module (D82); they meet in the registry.
    const holder = globalThis as Record<symbol, Translator | undefined>;
    holder[Symbol.for('datanest.translator')] = (template) => `[${template}]`;
    expect(msg('Login failed')).toBe('[Login failed]');
  });
});

describe('messages of the layers below the editor', () => {
  it('are translated when shown, never once at load time', async () => {
    // A message made while a module loads would stay English: the translator is
    // installed by activate(), after the bundles are loaded.
    const made: string[] = [];
    setTranslator((template, args) => {
      made.push(template);
      return formatMessage(template, args);
    });
    const files = ['core', 'shared', 'services', 'drivers']
      .flatMap((layer) => sourceFiles(join(ROOT, 'src', layer)))
      // The SQLite worker refuses to load outside a worker thread.
      .filter((file) => !file.endsWith(join('sqlite', 'worker.ts')));
    expect(files.length).toBeGreaterThan(200);
    for (const file of files) {
      await import(file);
    }
    expect(made).toEqual([]);
  }, 60_000);
});
