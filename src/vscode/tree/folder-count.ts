// How a Redis folder shows its keys (V13.7): the loaded ones until the user counts them,
// then the full number, `≥` when the count stopped at its cap. Free of `vscode`.

import type { FolderCount } from '../../services/redis/key-browser';

/** What the item of a folder says about the number of its keys. */
export type FolderCountView =
  | { readonly kind: 'loaded'; readonly text: string }
  | { readonly kind: 'counting'; readonly found: string; readonly text: string }
  | {
      readonly kind: 'counted';
      readonly exact: boolean;
      readonly count: string;
      readonly text: string;
    };

/** The description of a folder; `format` writes a number in the user's language. */
export function folderCountView(
  loaded: number,
  total: FolderCount | undefined,
  format: (count: number) => string,
): FolderCountView {
  if (total === undefined) {
    return { kind: 'loaded', text: format(loaded) };
  }
  if (total.state === 'counting') {
    const found = format(total.found);
    return { kind: 'counting', found, text: `… ${found}` };
  }
  const count = format(total.count);
  return {
    kind: 'counted',
    exact: total.exact,
    count,
    text: total.exact ? count : `≥ ${count}`,
  };
}
