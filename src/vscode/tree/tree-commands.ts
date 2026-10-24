// Commands driven by the tree. The editor bits they need (clipboard, one message)
// arrive through the deps, so the behaviour is covered by unit tests.

import { DbError } from '../../core/errors';
import type { ConnectionManager } from '../../services/connection-manager';
import { connectionIdOf, isTreeNode, nameOf, type TableNode, type TreeNode } from './nodes';

/** What the tree view offers; `vscode.env.clipboard` satisfies it. */
export interface Clipboard {
  writeText(text: string): PromiseLike<void>;
}

/** The part of the tree view these commands drive. */
export interface RefreshableTree {
  refresh(node?: TreeNode): void;
}

/** The part of the metadata cache these commands drive. */
export interface InvalidatableCache {
  invalidate(connectionId?: string): void;
}

export interface TreeCommandDeps {
  readonly manager: Pick<ConnectionManager, 'connect' | 'disconnect'>;
  /** Opens a table from the tree; the host wires this to the table viewer. */
  readonly openTable: (node: TableNode) => Promise<void>;
  readonly tree: RefreshableTree;
  readonly cache: InvalidatableCache;
  readonly clipboard: Clipboard;
  /** Shown when a command that needs a connection is run from the palette. */
  readonly noTargetMessage: string;
}

export type TreeCommandName = 'connect' | 'disconnect' | 'refresh' | 'copyName' | 'openTable';

/** What a tree command receives: the clicked node, a bare id, or nothing. */
export type CommandTarget = TreeNode | string | undefined;

export function treeCommandHandlers(
  deps: TreeCommandDeps,
): Record<TreeCommandName, (target?: CommandTarget) => unknown> {
  const requireConnectionId = (target: CommandTarget): string => {
    const connectionId = connectionIdOf(target);
    if (connectionId === undefined) {
      throw new DbError('not-found', deps.noTargetMessage);
    }
    return connectionId;
  };

  return {
    connect: async (target?: CommandTarget) => {
      await deps.manager.connect(requireConnectionId(target));
      deps.tree.refresh();
      return undefined;
    },

    disconnect: async (target?: CommandTarget) => {
      await deps.manager.disconnect(requireConnectionId(target));
      deps.tree.refresh();
      return undefined;
    },

    /**
     * Refreshes the clicked subtree, or everything when run from the view title.
     * The cached structure is dropped first: Refresh means "ask the server again".
     */
    refresh: (target?: CommandTarget) => {
      const node = isTreeNode(target) ? target : undefined;
      deps.cache.invalidate(node === undefined ? undefined : connectionIdOf(node));
      deps.tree.refresh(node);
      return undefined;
    },

    /** Opens a table or a view; other nodes are ignored. */
    openTable: async (target?: CommandTarget) => {
      if (isTreeNode(target) && target.kind === 'table') {
        await deps.openTable(target);
      }
      return undefined;
    },

    /** Copies the object name; nodes without a name of their own do nothing. */
    copyName: async (target?: CommandTarget) => {
      const name = isTreeNode(target) ? nameOf(target) : undefined;
      if (name !== undefined) {
        await deps.clipboard.writeText(name);
      }
      return undefined;
    },
  };
}
