// Folders of connections nest (V13.8). A folder is named by its path: the names of
// the folders from the top, joined with "/". A path with no "/" is exactly what a
// one-level folder was, so saved connections and export files keep working as they are.
// Free of everything else, so the rules are unit-tested and shared by host and page.

export const FOLDER_SEPARATOR = '/';

/** Folders inside folders, at most this deep (the top level is depth 1). */
export const MAX_FOLDER_DEPTH = 8;

/** The names of a path, from the top. */
export function folderSegments(path: string): string[] {
  return path.split(FOLDER_SEPARATOR);
}

export function joinFolder(parent: string | undefined, name: string): string {
  return parent === undefined || parent === '' ? name : `${parent}${FOLDER_SEPARATOR}${name}`;
}

/** The folder around this one; undefined at the top level. */
export function parentFolder(path: string): string | undefined {
  const cut = path.lastIndexOf(FOLDER_SEPARATOR);
  return cut === -1 ? undefined : path.slice(0, cut);
}

/** The last name of a path: what the tree shows for the folder. */
export function folderBaseName(path: string): string {
  return path.slice(path.lastIndexOf(FOLDER_SEPARATOR) + 1);
}

export function folderDepth(path: string): number {
  return folderSegments(path).length;
}

/** The folders around a path from the top, the path itself not included. */
export function folderAncestors(path: string): string[] {
  const segments = folderSegments(path);
  return segments
    .slice(0, -1)
    .map((_name, index) => segments.slice(0, index + 1).join(FOLDER_SEPARATOR));
}

/** `path` is `ancestor` or lies somewhere below it. */
export function isInFolder(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(`${ancestor}${FOLDER_SEPARATOR}`);
}

/**
 * Puts the part of `path` that is `from` under the name `to` (undefined: the top
 * level, so the part is simply cut off), e.g. after a move. `path` must be in `from`.
 */
export function replaceFolderPrefix(path: string, from: string, to: string | undefined): string {
  const rest = path.slice(from.length);
  return to === undefined ? rest.slice(1) : `${to}${rest}`;
}

/** The deepest depth any of the paths reaches; 0 for none. */
export function deepestFolder(paths: readonly string[]): number {
  return paths.reduce((deepest, path) => Math.max(deepest, folderDepth(path)), 0);
}

/**
 * A path with every name trimmed and empty ones dropped (`" a // b "` is `a/b`);
 * undefined when nothing is left. Reading a saved or imported path goes through here.
 */
export function cleanFolderPath(path: string | undefined): string | undefined {
  const names = (path ?? '')
    .split(FOLDER_SEPARATOR)
    .map((name) => name.trim())
    .filter((name) => name !== '');
  return names.length === 0 ? undefined : names.join(FOLDER_SEPARATOR);
}

/** Folders directly inside `parent` (undefined: the top level), in the order given. */
export function childFolders(folders: readonly string[], parent: string | undefined): string[] {
  return folders.filter((folder) => parentFolder(folder) === parent);
}

/**
 * Every folder with the folders around it, parents before what they hold, otherwise in
 * the order given. A saved list may name `a/b` without `a`; the tree needs both.
 */
export function withAncestors(folders: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const folder of folders) {
    for (const path of [...folderAncestors(folder), folder]) {
      if (!seen.has(path)) {
        seen.add(path);
        result.push(path);
      }
    }
  }
  return result;
}

/** How many of the connections (named by their folder) are in the folder or below it. */
export function countInFolder(
  connectionFolders: readonly (string | undefined)[],
  path: string,
): number {
  return connectionFolders.filter((folder) => folder !== undefined && isInFolder(folder, path))
    .length;
}
