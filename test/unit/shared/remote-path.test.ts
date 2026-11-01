import { describe, expect, it } from 'vitest';
import {
  baseName,
  isInside,
  isValidName,
  joinRemote,
  modeOctal,
  modeText,
  parentPath,
  parseMode,
} from '../../../src/shared/remote-path';

describe('remote paths', () => {
  it('joins with one slash', () => {
    expect(joinRemote('/a', 'b')).toBe('/a/b');
    expect(joinRemote('/a/', 'b')).toBe('/a/b');
    expect(joinRemote('/', 'b')).toBe('/b');
  });

  it('names the last part', () => {
    expect(baseName('/a/b.txt')).toBe('b.txt');
    expect(baseName('/a/b/')).toBe('b');
    expect(baseName('rel')).toBe('rel');
    expect(baseName('/')).toBe('/');
  });

  it('finds the folder above', () => {
    expect(parentPath('/a/b/c')).toBe('/a/b');
    expect(parentPath('/a/b/')).toBe('/a');
    expect(parentPath('/a')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(parentPath('rel')).toBe('.');
    expect(parentPath('x/y')).toBe('x');
  });

  it('tells what lies inside a folder, and not a folder with the same start', () => {
    expect(isInside('/a', '/a')).toBe(true);
    expect(isInside('/a', '/a/b/c')).toBe(true);
    expect(isInside('/a/', '/a/b')).toBe(true);
    expect(isInside('/a', '/ab')).toBe(false);
    expect(isInside('/a/b', '/a')).toBe(false);
    expect(isInside('/', '/any')).toBe(true);
  });

  it('accepts names that can be created', () => {
    expect(isValidName('file.txt')).toBe(true);
    expect(isValidName('.hidden')).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\0b']) {
      expect(isValidName(bad)).toBe(false);
    }
  });
});

describe('modes', () => {
  it('writes permissions the way ls does', () => {
    expect(modeText(0o644)).toBe('rw-r--r--');
    expect(modeText(0o755)).toBe('rwxr-xr-x');
    expect(modeText(0o000)).toBe('---------');
    expect(modeText(0o100644)).toBe('rw-r--r--');
  });

  it('marks the special bits', () => {
    expect(modeText(0o4755)).toBe('rwsr-xr-x');
    expect(modeText(0o4644)).toBe('rwSr--r--');
    expect(modeText(0o2755)).toBe('rwxr-sr-x');
    expect(modeText(0o1777)).toBe('rwxrwxrwt');
    expect(modeText(0o1776)).toBe('rwxrwxrwT');
  });

  it('reads the octal people type', () => {
    expect(parseMode('755')).toBe(0o755);
    expect(parseMode(' 0644 ')).toBe(0o644);
    expect(parseMode('4755')).toBe(0o4755);
    for (const bad of ['', '75', '89', '12345', 'rwx', '7 5 5']) {
      expect(parseMode(bad)).toBeUndefined();
    }
  });

  it('shows a mode as octal without the file type', () => {
    expect(modeOctal(0o100644)).toBe('644');
    expect(modeOctal(0o40755)).toBe('755');
    expect(modeOctal(0o104755)).toBe('4755');
    expect(modeOctal(0o7)).toBe('007');
  });
});
