import * as vscode from 'vscode';
import { type FavoritesStore, MAX_FAVORITES } from './favorites';
import { isTreeNode } from './nodes';

export type FavoriteCommandName = 'add' | 'remove';

/**
 * Stars a node and takes the star off. Both are no-ops when the node is already in the
 * wanted state, so a stale menu cannot flip it back. They run from the tree only: a
 * command needs a node to work on.
 */
export function favoriteCommandHandlers(deps: {
  readonly favorites: FavoritesStore;
}): Record<FavoriteCommandName, (target?: unknown) => Promise<void>> {
  const set = async (target: unknown, wanted: boolean): Promise<void> => {
    if (!isTreeNode(target) || deps.favorites.has(target) === wanted) {
      return;
    }
    if ((await deps.favorites.toggle(target)) === undefined && wanted) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('You can star up to {0} nodes: take a star off first', MAX_FAVORITES),
      );
    }
  };
  return {
    add: async (target) => {
      await set(target, true);
    },
    remove: async (target) => {
      await set(target, false);
    },
  };
}
