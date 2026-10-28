// Which databases and schemas a connection shows (V4.10). A filter is a list of
// patterns: `*` stands for any run of characters, `?` for one; a pattern that starts
// with `!` hides what it matches. Names are compared without regard to case, as
// people type them, although some servers would tell `App` from `app`.

/** Visible names, in the order given. No patterns at all shows everything. */
export function filterNames(names: readonly string[], patterns: readonly string[]): string[] {
  const visible = nameFilter(patterns);
  return names.filter((name) => visible(name));
}

/**
 * A name is visible when it matches a showing pattern (or there are none) and no
 * hiding one: `app_*, !app_test` shows every `app_` database but the test one.
 */
export function nameFilter(patterns: readonly string[]): (name: string) => boolean {
  const shown: RegExp[] = [];
  const hidden: RegExp[] = [];
  for (const raw of patterns) {
    const pattern = raw.trim();
    if (pattern.startsWith('!')) {
      if (pattern.length > 1) {
        hidden.push(toRegExp(pattern.slice(1)));
      }
    } else if (pattern !== '') {
      shown.push(toRegExp(pattern));
    }
  }
  return (name) =>
    (shown.length === 0 || shown.some((re) => re.test(name))) &&
    !hidden.some((re) => re.test(name));
}

function toRegExp(pattern: string): RegExp {
  // Array.from walks code points, so a name with emoji or CJK keeps its characters.
  const body = Array.from(pattern)
    .map((char) =>
      char === '*' ? '.*' : char === '?' ? '.' : char.replace(/[.+^${}()|[\]\\]/gu, '\\$&'),
    )
    .join('');
  return new RegExp(`^${body}$`, 'iu');
}

/** Patterns typed as one line or several: split on commas and new lines, blanks dropped. */
export function parsePatterns(text: string): string[] {
  return text
    .split(/[,\n]/u)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');
}
