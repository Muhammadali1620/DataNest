// Paths on a server (V13.16). They always use `/`, whatever system this machine runs, so
// `node:path` is not used for them.

/** Joins a folder and a name; `/` and `a/` both work as the folder. */
export function joinRemote(folder: string, name: string): string {
  return folder.endsWith('/') ? `${folder}${name}` : `${folder}/${name}`;
}

/** The last part of a path; `/` for the root. */
export function baseName(path: string): string {
  const trimmed = trimSlashes(path);
  const slash = trimmed.lastIndexOf('/');
  const name = slash === -1 ? trimmed : trimmed.slice(slash + 1);
  return name === '' ? '/' : name;
}

/** The folder a path sits in; `/` for a top-level name and for the root itself. */
export function parentPath(path: string): string {
  const trimmed = trimSlashes(path);
  const slash = trimmed.lastIndexOf('/');
  if (slash === -1) {
    return trimmed.startsWith('/') ? '/' : '.';
  }
  return slash === 0 ? '/' : trimmed.slice(0, slash);
}

function trimSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') {
    end -= 1;
  }
  return path.slice(0, end);
}

/** True when `path` is `folder` itself or lies below it. */
export function isInside(folder: string, path: string): boolean {
  const base = trimSlashes(folder);
  const target = trimSlashes(path);
  return target === base || (base === '/' ? target.startsWith('/') : target.startsWith(`${base}/`));
}

/** A name that may be created in a folder: not empty, not `.` or `..`, no `/`. */
export function isValidName(name: string): boolean {
  return (
    name !== '' && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
  );
}

/** The permission part of a mode as `rwxr-xr-x`, with `s`/`t` for the special bits. */
export function modeText(mode: number): string {
  const letters = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
  const chars = letters.map((letter, index) => ((mode & (0o400 >> index)) === 0 ? '-' : letter));
  const swap = (at: number, special: boolean, on: string): void => {
    if (special) {
      chars[at] = chars[at] === 'x' ? on : on.toUpperCase();
    }
  };
  swap(2, (mode & 0o4000) !== 0, 's');
  swap(5, (mode & 0o2000) !== 0, 's');
  swap(8, (mode & 0o1000) !== 0, 't');
  return chars.join('');
}

/** Parses `755` or `0644` (octal digits, 3 or 4 of them) into mode bits; undefined if not one. */
export function parseMode(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^[0-7]{3,4}$/u.test(trimmed)) {
    return undefined;
  }
  return Number.parseInt(trimmed, 8);
}

/** The low twelve bits of a mode as the octal text people type: `755`, `4755`. */
export function modeOctal(mode: number): string {
  const bits = mode & 0o7777;
  return bits.toString(8).padStart(3, '0');
}
