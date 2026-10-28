// What a pick of visible databases or schemas means for the filter (V4.10). Free of
// `vscode`, so the rules are unit tests.

import { nameFilter } from '../../shared/name-filter';
import type { VisibilityFilter } from '../../shared/connection';

export type FilterKind = keyof VisibilityFilter;

/** The names the current patterns show; they start ticked in the list. */
export function initiallyPicked(all: readonly string[], patterns: readonly string[]): string[] {
  const visible = nameFilter(patterns);
  return all.filter((name) => visible(name));
}

export type PickOutcome =
  /** Everything ticked: the filter goes away, so new databases show up too. */
  | { readonly kind: 'all' }
  /** The ticked names become the filter, in list order. */
  | { readonly kind: 'some'; readonly patterns: string[] }
  /** Nothing ticked: refused, an empty tree would look like a lost connection. */
  | { readonly kind: 'none' };

export function pickOutcome(all: readonly string[], picked: readonly string[]): PickOutcome {
  const chosen = new Set(picked);
  const patterns = all.filter((name) => chosen.has(name));
  if (patterns.length === 0) {
    return { kind: 'none' };
  }
  return patterns.length === all.length ? { kind: 'all' } : { kind: 'some', patterns };
}

/** The filter with one list replaced; an empty list removes it, and an empty filter too. */
export function withList(
  filter: VisibilityFilter | undefined,
  kind: FilterKind,
  patterns: readonly string[],
): VisibilityFilter | undefined {
  const { [kind]: _old, ...rest } = filter ?? {};
  const next: VisibilityFilter = patterns.length === 0 ? rest : { ...rest, [kind]: patterns };
  return Object.keys(next).length === 0 ? undefined : next;
}
