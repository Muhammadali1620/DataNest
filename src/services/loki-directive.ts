// Edits the `# key: value` comment lines that set the window of a LogQL query (V13.27), without
// `vscode`. The lines sit at the very top of a statement (D155); this finds the one for a key in
// that leading block and changes it, or adds it above the query.

/** The lines at the top of the text that are `#` comments, up to the first line that is not. */
function leadingCommentLines(lines: readonly string[]): number {
  let count = 0;
  while (count < lines.length && /^\s*#/u.test(lines[count] ?? '')) {
    count += 1;
  }
  return count;
}

/**
 * Returns the text with the directive `# key: value` in place of an earlier one for the same
 * key in the leading comments, or added as the first line. A line of several directives
 * (`# range: 1h # step: 1m`) keeps the others.
 */
export function setLeadingDirective(text: string, key: string, value: string): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/u);
  const own = new RegExp(`(^|\\s)#\\s*${key}\\s*:\\s*[^#]*?(?=\\s#\\s|\\s*$)`, 'iu');
  const leading = leadingCommentLines(lines);
  for (let index = 0; index < leading; index += 1) {
    const line = lines[index] ?? '';
    if (own.test(line)) {
      lines[index] = line.replace(own, (_match, before: string) => `${before}# ${key}: ${value}`);
      return lines.join(newline);
    }
  }
  return `# ${key}: ${value}${newline}${text}`;
}

/** The value of the directive `# key:` in the leading comments, if there is one. */
export function leadingDirective(text: string, key: string): string | undefined {
  const lines = text.split(/\r?\n/u);
  const own = new RegExp(`(?:^|\\s)#\\s*${key}\\s*:\\s*([^#]*?)(?=\\s#\\s|\\s*$)`, 'iu');
  const leading = leadingCommentLines(lines);
  for (let index = 0; index < leading; index += 1) {
    const found = own.exec(lines[index] ?? '');
    if (found !== null) {
      return found[1]?.trim();
    }
  }
  return undefined;
}
