/** A value a test expects to be there; fails with a clear message instead of a `!`. */
export function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === undefined || value === null) {
    throw new Error(`Expected ${what} to exist`);
  }
  return value;
}
