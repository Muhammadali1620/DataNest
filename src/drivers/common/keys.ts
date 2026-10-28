/**
 * Rows of (index, column) in index order become one list per index. An index with a
 * missing column name is an expression index and is dropped whole.
 */
export function groupKeys(
  rows: readonly (readonly [string | undefined, string | undefined])[],
): string[][] {
  const keys = new Map<string, string[] | null>();
  for (const [index, column] of rows) {
    if (index === undefined) {
      continue;
    }
    // null marks an index already dropped; it must stay dropped.
    const key = keys.has(index) ? keys.get(index) : [];
    keys.set(
      index,
      key === null || key === undefined || column === undefined ? null : [...key, column],
    );
  }
  return [...keys.values()].filter((key): key is string[] => key !== null && key.length > 0);
}
