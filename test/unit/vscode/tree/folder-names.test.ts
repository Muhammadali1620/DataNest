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
});
