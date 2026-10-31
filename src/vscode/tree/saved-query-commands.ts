// The commands of the "Query" folder (V11.12): a new saved query, opening, renaming and
// deleting one. The editor bits arrive through the deps, so the flow is unit-tested.

import { isDbError } from '../../core/errors';
import type { ObjectScope } from '../../core/model/objects';
import type { SavedQueryStore } from '../../services/saved-queries';
import { savedQueryName, savedQueryNameProblem } from '../../services/saved-queries';
import { isTreeNode, type QueryFolderNode, type SavedQueryNode, type TreeNode } from './nodes';
import type { CommandTarget, RefreshableTree } from './tree-commands';

export interface SavedQueryTexts {
  readonly newName: string;
  renameTo(name: string): string;
  deleteQuery(name: string): string;
  readonly delete: string;
  /** Said when the file system refuses (a name that is taken, a folder that cannot be made). */
  failed(message: string): string;
}

export interface SavedQueryDeps {
  readonly store: Pick<SavedQueryStore, 'create' | 'rename' | 'remove' | 'pathOf'>;
  /** Opens the file in an editor bound to the connection and database. */
  readonly open: (connectionId: string, scope: ObjectScope, path: string) => Promise<void>;
  readonly askName: (options: {
    readonly title: string;
    readonly value: string;
    readonly validate: (name: string) => string | undefined;
  }) => Promise<string | undefined>;
  readonly confirmDelete: (title: string, deleteLabel: string) => Promise<boolean>;
  readonly tree: RefreshableTree;
  readonly texts: SavedQueryTexts;
  readonly showError: (message: string) => void;
}

export type SavedQueryCommandName =
  'newSavedQuery' | 'openSavedQuery' | 'renameSavedQuery' | 'deleteSavedQuery';

function folderOf(node: SavedQueryNode): QueryFolderNode {
  return { kind: 'queryFolder', connectionId: node.connectionId, scope: node.scope };
}

export function savedQueryCommandHandlers(
  deps: SavedQueryDeps,
): Record<SavedQueryCommandName, (target?: CommandTarget) => Promise<void>> {
  const { store, texts } = deps;
  const node = <K extends TreeNode['kind']>(
    target: CommandTarget,
    kind: K,
  ): Extract<TreeNode, { kind: K }> | undefined =>
    isTreeNode(target) && target.kind === kind
      ? (target as Extract<TreeNode, { kind: K }>)
      : undefined;
  const guarded = async (action: () => Promise<void>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      if (isDbError(error)) {
        deps.showError(texts.failed(error.message));
        return;
      }
      throw error;
    }
  };

  return {
    newSavedQuery: async (target) => {
      const folder = node(target, 'queryFolder');
      if (folder === undefined) {
        return;
      }
      const name = await deps.askName({
        title: texts.newName,
        value: 'query',
        validate: (value) => savedQueryNameProblem(savedQueryName(value)),
      });
      if (name === undefined) {
        return;
      }
      await guarded(async () => {
        const created = await store.create(folder.connectionId, folder.scope, name);
        deps.tree.refresh(folder);
        await deps.open(folder.connectionId, folder.scope, created.path);
      });
    },

    openSavedQuery: async (target) => {
      const query = node(target, 'savedQuery');
      if (query !== undefined) {
        await deps.open(
          query.connectionId,
          query.scope,
          store.pathOf(query.connectionId, query.scope, query.name),
        );
      }
    },

    renameSavedQuery: async (target) => {
      const query = node(target, 'savedQuery');
      if (query === undefined) {
        return;
      }
      const name = await deps.askName({
        title: texts.renameTo(query.name),
        value: query.name,
        validate: (value) =>
          savedQueryName(value) === query.name
            ? undefined
            : savedQueryNameProblem(savedQueryName(value)),
      });
      if (name === undefined || savedQueryName(name) === query.name) {
        return;
      }
      await guarded(async () => {
        await store.rename(query.connectionId, query.scope, query.name, name);
        deps.tree.refresh(folderOf(query));
      });
    },

    deleteSavedQuery: async (target) => {
      const query = node(target, 'savedQuery');
      if (
        query === undefined ||
        !(await deps.confirmDelete(texts.deleteQuery(query.name), texts.delete))
      ) {
        return;
      }
      await guarded(async () => {
        await store.remove(query.connectionId, query.scope, query.name);
        deps.tree.refresh(folderOf(query));
      });
    },
  };
}
