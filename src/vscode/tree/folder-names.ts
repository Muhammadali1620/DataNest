// Checking folder names, kept free of `vscode` so the rules are unit-tested.

import { CONNECTION_LIMITS } from '../../shared/connection';

/** Why a folder name cannot be used, or undefined when it can. */
export function folderNameProblem(
  name: string,
  existing: readonly string[],
  current?: string,
): 'empty' | 'too-long' | 'taken' | undefined {
  const trimmed = name.trim();
  if (trimmed === '') {
    return 'empty';
  }
  if (trimmed.length > CONNECTION_LIMITS.folder) {
    return 'too-long';
  }
  return trimmed !== current && existing.includes(trimmed) ? 'taken' : undefined;
}
