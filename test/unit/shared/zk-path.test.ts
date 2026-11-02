import { describe, expect, it } from 'vitest';
import {
  hexId,
  isSequentialName,
  joinPath,
  kindOfOwner,
  nameOf,
  nameProblem,
  parentPath,
  pathProblem,
  permissionLetters,
  ROOT_PATH,
} from '../../../src/shared/zk-path';

describe('paths', () => {
  it('join a name to the parent, the root included', () => {
    expect(joinPath('/', 'a')).toBe('/a');
    expect(joinPath('/a', 'b')).toBe('/a/b');
    expect(joinPath('/a/b', 'c d')).toBe('/a/b/c d');
  });

  it('find the parent and the name', () => {
    expect(parentPath('/a/b')).toBe('/a');
    expect(parentPath('/a')).toBe('/');
    expect(parentPath('/')).toBe('/');
    expect(nameOf('/a/b')).toBe('b');
    expect(nameOf('/a')).toBe('a');
    expect(nameOf('/')).toBe(ROOT_PATH);
  });
});

describe('nameProblem and pathProblem', () => {
  it('accept the names the server accepts', () => {
    for (const name of ['a', 'имя', 'with space', 'dots.in.name', '...', '-x', 'a'.repeat(1000)]) {
      expect(nameProblem(name)).toBeUndefined();
    }
  });

  it('name what is wrong with the others', () => {
    expect(nameProblem('')).toBe('empty');
    expect(nameProblem('a/b')).toBe('slash');
    expect(nameProblem('.')).toBe('dots');
    expect(nameProblem('..')).toBe('dots');
    expect(nameProblem('a\u0000b')).toBe('null');
    expect(nameProblem('a'.repeat(1001))).toBe('long');
  });

  it('check every part of a path', () => {
    expect(pathProblem('/')).toBeUndefined();
    expect(pathProblem('/a/b')).toBeUndefined();
    expect(pathProblem('a/b')).toBe('relative');
    expect(pathProblem('')).toBe('relative');
    expect(pathProblem('/a//b')).toBe('empty');
    expect(pathProblem('/a/')).toBe('empty');
    expect(pathProblem('/a/../b')).toBe('dots');
  });
});

describe('isSequentialName', () => {
  it('tells the counter the server adds', () => {
    expect(isSequentialName('job-0000000012')).toBe(true);
    expect(isSequentialName('0000000000')).toBe(true);
    expect(isSequentialName('job-12')).toBe(false);
    expect(isSequentialName('job')).toBe(false);
  });
});

describe('kindOfOwner', () => {
  it('reads the owner of a stat', () => {
    expect(kindOfOwner('0')).toBe('persistent');
    expect(kindOfOwner('72057594037927937')).toBe('ephemeral');
    expect(kindOfOwner((1n << 63n).toString())).toBe('container');
    expect(kindOfOwner(((0xffn << 56n) | 5n).toString())).toBe('ttl');
    expect(kindOfOwner('not a number')).toBe('persistent');
  });
});

describe('hexId and permissionLetters', () => {
  it('write ids as the server tools do', () => {
    expect(hexId('4294967297')).toBe('0x100000001');
    expect(hexId('0')).toBe('0x0');
    expect(hexId('oops')).toBe('oops');
  });

  it('write permissions as letters', () => {
    expect(permissionLetters(31)).toBe('rwcda');
    expect(permissionLetters(1)).toBe('r----');
    expect(permissionLetters(0)).toBe('-----');
    expect(permissionLetters(2 | 8)).toBe('-w-d-');
    expect(permissionLetters(4 | 16)).toBe('--c-a');
  });
});
