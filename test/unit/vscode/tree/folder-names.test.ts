import { describe, expect, it } from 'vitest';
import { folderNameProblem } from '../../../../src/vscode/tree/folder-names';

describe('folderNameProblem', () => {
  it('accepts a new name and the current one', () => {
    expect(folderNameProblem('Prod', [])).toBeUndefined();
    expect(folderNameProblem(' Prod ', ['Prod'], 'Prod')).toBeUndefined();
  });

  it('refuses empty, too long and taken names', () => {
    expect(folderNameProblem('  ', [])).toBe('empty');
    expect(folderNameProblem('x'.repeat(201), [])).toBe('too-long');
    expect(folderNameProblem('Dev ', ['Prod', 'Dev'], 'Prod')).toBe('taken');
  });

  it('refuses a separator: one name is one level (V13.8)', () => {
    expect(folderNameProblem('A/B', [])).toBe('separator');
  });

  it('looks for a clash inside the parent, not among all folders', () => {
    const existing = ['Work', 'Work/Prod', 'Prod'];
    expect(folderNameProblem('Prod', existing, undefined, 'Work')).toBe('taken');
    expect(folderNameProblem('Dev', existing, undefined, 'Work')).toBeUndefined();
    expect(folderNameProblem('Prod', existing, undefined, 'Other')).toBeUndefined();
    expect(folderNameProblem('Prod', existing)).toBe('taken');
  });

  it('renames inside the parent the folder already has, and keeps its own name', () => {
    const existing = ['Work', 'Work/Prod', 'Work/Dev', 'Prod'];
    expect(folderNameProblem('Prod', existing, 'Work/Prod')).toBeUndefined();
    expect(folderNameProblem('Dev', existing, 'Work/Prod')).toBe('taken');
    expect(folderNameProblem('Live', existing, 'Work/Prod')).toBeUndefined();
  });

  it('refuses a name that nests too deep', () => {
    const parent = 'a/b/c/d/e/f/g';
    expect(folderNameProblem('h', [], undefined, parent)).toBeUndefined();
    expect(folderNameProblem('i', [], undefined, `${parent}/h`)).toBe('too-deep');
  });
});
