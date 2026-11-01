import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { cdLine, shellQuote } from '../../../src/shared/shell-quote';

describe('shellQuote', () => {
  it('wraps a plain word in single quotes', () => {
    expect(shellQuote('/var/www')).toBe("'/var/www'");
  });

  it('keeps spaces and shell characters inside one word', () => {
    expect(shellQuote('my folder; rm -rf /')).toBe("'my folder; rm -rf /'");
    expect(shellQuote('$HOME `id` $(id) "x" \\ *')).toBe('\'$HOME `id` $(id) "x" \\ *\'');
  });

  it('turns a single quote into close, escaped quote, open', () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("''")).toBe("''\\'''\\'''");
  });

  it('quotes an empty string and a newline', () => {
    expect(shellQuote('')).toBe("''");
    expect(shellQuote('a\nb')).toBe("'a\nb'");
  });

  it.skipIf(process.platform === 'win32')('is read back unchanged by a real POSIX shell', () => {
    for (const text of [
      'plain',
      'with space',
      "it's",
      '$HOME',
      '`id`',
      '$(id)',
      'a;b&&c|d',
      '"quoted"',
      '\\back\\slash',
      '*?[a]',
      '-dash',
      'ünï cödé',
    ]) {
      const out = spawnSync('sh', ['-c', `printf %s ${shellQuote(text)}`], { encoding: 'utf8' });
      expect(out.stdout).toBe(text);
    }
  });
});

describe('cdLine', () => {
  it('ends the option list, quotes the path and ends the line', () => {
    expect(cdLine('/srv/my app')).toBe("cd -- '/srv/my app'\n");
  });

  it('survives a path that starts with a dash or holds a quote', () => {
    expect(cdLine('-rf')).toBe("cd -- '-rf'\n");
    expect(cdLine("/it's")).toBe("cd -- '/it'\\''s'\n");
  });

  it.skipIf(process.platform === 'win32')('really changes into such a folder', () => {
    const line = cdLine('/');
    const out = spawnSync('sh', ['-c', `${line}pwd`], { encoding: 'utf8' });
    expect(out.stdout.trim()).toBe('/');
  });
});
