// Quoting for a POSIX shell (V13.18): a folder name typed into a remote shell must stay one
// word whatever it holds — spaces, quotes, `$`, `;`, a leading dash. Free of Node and the
// editor, so the rules are unit-tested.

/** `text` as one single-quoted shell word; a quote inside becomes `'\''`. */
export function shellQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The line that moves a fresh shell into `path`. `--` keeps a path that starts with a dash
 * from being read as an option; a failed `cd` leaves the shell where it started, with the
 * shell's own message, so nothing here needs to judge it.
 */
export function cdLine(path: string): string {
  return `cd -- ${shellQuote(path)}\n`;
}
