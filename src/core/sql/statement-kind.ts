// Enough SQL reading to tell whether a statement changed the structure, so caches
// can be dropped. A full tokenizer arrives in V1.13; this only looks at the first
// keyword, but it skips comments properly so a commented-out verb never counts.

/** Verbs that change what the tree and completion show. */
const STRUCTURE_VERBS = new Set([
  'CREATE',
  'ALTER',
  'DROP',
  'TRUNCATE',
  'RENAME',
  'COMMENT',
  'GRANT',
  'REVOKE',
  'ATTACH',
  'DETACH',
  'VACUUM',
  'ANALYZE',
  'REINDEX',
  'REFRESH',
]);

/** Leading whitespace and comments are not part of the statement. */
export function stripLeadingNoise(sql: string): string {
  let index = 0;
  for (;;) {
    while (index < sql.length && /\s/.test(sql[index] ?? '')) {
      index++;
    }
    if (sql.startsWith('--', index)) {
      const end = sql.indexOf('\n', index);
      if (end === -1) {
        return '';
      }
      index = end + 1;
      continue;
    }
    if (sql.startsWith('#', index)) {
      // MySQL also treats # as a line comment.
      const end = sql.indexOf('\n', index);
      if (end === -1) {
        return '';
      }
      index = end + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const end = sql.indexOf('*/', index + 2);
      if (end === -1) {
        return '';
      }
      index = end + 2;
      continue;
    }
    return sql.slice(index);
  }
}

/** The first keyword of a statement, uppercased; empty when there is none. */
export function leadingKeyword(sql: string): string {
  const rest = stripLeadingNoise(sql);
  const match = /^[A-Za-z_]+/.exec(rest);
  return match === null ? '' : match[0].toUpperCase();
}

/**
 * True when running this statement may have changed the database structure.
 * Deliberately generous: dropping a cache too often costs one extra query, while
 * keeping a stale one shows the user objects that no longer exist.
 */
export function changesStructure(sql: string): boolean {
  const keyword = leadingKeyword(sql);
  if (keyword === '') {
    return false;
  }
  if (STRUCTURE_VERBS.has(keyword)) {
    return true;
  }
  // `CALL`/`EXEC` may run anything, and a procedure often creates or drops objects.
  return keyword === 'CALL' || keyword === 'EXEC' || keyword === 'EXECUTE';
}
