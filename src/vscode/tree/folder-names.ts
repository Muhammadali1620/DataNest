// Checking folder names, kept free of `vscode` so the rules are unit-tested.

import { CONNECTION_LIMITS } from '../../shared/connection';
import {
  FOLDER_SEPARATOR,
  folderDepth,
  joinFolder,
  MAX_FOLDER_DEPTH,
  parentFolder,
} from '../../shared/folder-path';

export type FolderNameProblem = 'empty' | 'too-long' | 'separator' | 'too-deep' | 'taken';

/**
 * Why a folder name cannot be used, or undefined when it can. `existing` are the paths of
 * all folders; `current` is the path of the folder being renamed, whose own name is fine.
 * The name is one level: `parent` says which folder it goes into (the top level when
 * absent), and a rename keeps the parent of the folder it renames.
 */
export function folderNameProblem(
  name: string,
  existing: readonly string[],
  current?: string,
  parent?: string,
): FolderNameProblem | undefined {
  const trimmed = name.trim();
  if (trimmed === '') {
    return 'empty';
  }
  if (trimmed.length > CONNECTION_LIMITS.folder) {
    return 'too-long';
  }
  if (trimmed.includes(FOLDER_SEPARATOR)) {
    return 'separator';
  }
  const path = joinFolder(current === undefined ? parent : parentFolder(current), trimmed);
  if (folderDepth(path) > MAX_FOLDER_DEPTH) {
    return 'too-deep';
  }
  return path !== current && existing.includes(path) ? 'taken' : undefined;
}
