import { describe, expect, it } from 'vitest';
import {
  childFolders,
  cleanFolderPath,
  countInFolder,
  deepestFolder,
  folderAncestors,
  folderBaseName,
  folderDepth,
  folderSegments,
  isInFolder,
  joinFolder,
  MAX_FOLDER_DEPTH,
  parentFolder,
  replaceFolderPrefix,
  withAncestors,
} from '../../../src/shared/folder-path';

describe('folder paths', () => {
  it('reads a one-level name exactly as before', () => {
    expect(folderSegments('Prod')).toEqual(['Prod']);
    expect(parentFolder('Prod')).toBeUndefined();
    expect(folderBaseName('Prod')).toBe('Prod');
    expect(folderDepth('Prod')).toBe(1);
    expect(folderAncestors('Prod')).toEqual([]);
  });

  it('splits a nested path', () => {
    expect(parentFolder('Work/Prod/EU')).toBe('Work/Prod');
    expect(folderBaseName('Work/Prod/EU')).toBe('EU');
    expect(folderDepth('Work/Prod/EU')).toBe(3);
    expect(folderAncestors('Work/Prod/EU')).toEqual(['Work', 'Work/Prod']);
  });

  it('joins a name to a parent, or to the top level', () => {
    expect(joinFolder(undefined, 'A')).toBe('A');
    expect(joinFolder('', 'A')).toBe('A');
    expect(joinFolder('X/Y', 'A')).toBe('X/Y/A');
  });

  it('says what is inside a folder without taking a name prefix for it', () => {
    expect(isInFolder('A', 'A')).toBe(true);
    expect(isInFolder('A/B', 'A')).toBe(true);
    expect(isInFolder('A/B/C', 'A/B')).toBe(true);
    expect(isInFolder('AB', 'A')).toBe(false);
    expect(isInFolder('A', 'A/B')).toBe(false);
    expect(isInFolder('B/A', 'A')).toBe(false);
  });

  it('puts the part of a path under a new name', () => {
    expect(replaceFolderPrefix('A/X/Y', 'A', 'B')).toBe('B/X/Y');
    expect(replaceFolderPrefix('A', 'A', 'B/C')).toBe('B/C');
    expect(replaceFolderPrefix('A/X', 'A', undefined)).toBe('X');
    expect(replaceFolderPrefix('A/X/Y', 'A/X', 'Q')).toBe('Q/Y');
  });

  it('finds the deepest path', () => {
    expect(deepestFolder([])).toBe(0);
    expect(deepestFolder(['A', 'A/B/C', 'D/E'])).toBe(3);
    expect(MAX_FOLDER_DEPTH).toBe(8);
  });

  it('tidies a path: trims names and drops empty ones', () => {
    expect(cleanFolderPath(' a // b ')).toBe('a/b');
    expect(cleanFolderPath('/a/')).toBe('a');
    expect(cleanFolderPath('Prod')).toBe('Prod');
    expect(cleanFolderPath('  /  ')).toBeUndefined();
    expect(cleanFolderPath('')).toBeUndefined();
    expect(cleanFolderPath(undefined)).toBeUndefined();
  });

  it('lists the folders directly inside another, in order', () => {
    const all = ['A', 'B', 'A/X', 'A/Y', 'A/X/Z', 'B/Q'];
    expect(childFolders(all, undefined)).toEqual(['A', 'B']);
    expect(childFolders(all, 'A')).toEqual(['A/X', 'A/Y']);
    expect(childFolders(all, 'A/X')).toEqual(['A/X/Z']);
    expect(childFolders(all, 'Nope')).toEqual([]);
  });

  it('adds the folders around nested ones, before them, once', () => {
    expect(withAncestors(['A/B/C', 'D', 'A/E'])).toEqual(['A', 'A/B', 'A/B/C', 'D', 'A/E']);
    expect(withAncestors(['A', 'B', 'A/X'])).toEqual(['A', 'B', 'A/X']);
    expect(withAncestors([])).toEqual([]);
  });

  it('counts the connections in a folder and below it', () => {
    const folders = ['A', 'A/B', 'A/B', undefined, 'AB', 'C'];
    expect(countInFolder(folders, 'A')).toBe(3);
    expect(countInFolder(folders, 'A/B')).toBe(2);
    expect(countInFolder(folders, 'Z')).toBe(0);
  });
});
