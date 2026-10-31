// Commands driven by the tree. The editor bits they need (clipboard, one message)
// arrive through the deps, so the behaviour is covered by unit tests.

import { DbError } from '../../core/errors';
import type { ObjectRef } from '../../core/model/objects';
import type { ConnectionManager } from '../../services/connection-manager';
import { DoubleClickDetector } from './double-click';
import type { ExpansionKeeper } from './expansion-keeper';
import { nodeSqlTargetOf } from './node-actions';
import type { NodeSqlTarget } from '../../services/node-sql';
import {
  connectionIdOf,
  isTreeNode,
  nameOf,
  nodeId,
  objectRefOf,
  type TableNode,
  type TreeNode,
} from './nodes';

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
  readonly manager: Pick<ConnectionManager, 'connectAny' | 'disconnect'>;
  /** Opens a table from the tree; the host wires this to the table viewer. */
  readonly openTable: (node: TableNode) => Promise<void>;
  /** Opens the definition of an object in a new SQL editor. */
  readonly showDefinition: (connectionId: string, object: ObjectRef) => Promise<void>;
  readonly tree: RefreshableTree;
  readonly cache: InvalidatableCache;
  readonly clipboard: Clipboard;
  /** Shown when a command that needs a connection is run from the palette. */
  readonly noTargetMessage: string;
  /** Reads the project files again (V4.7), for a refresh of the whole tree. */
  readonly reloadProjects?: () => Promise<void>;
  /** Asked before disconnecting; false keeps the connection (open transactions, V4.8). */
  readonly confirmDisconnect?: (connectionId: string) => Promise<boolean>;
  /** Tells a double click from two single ones; tests pass a clock they control. */
  readonly doubleClick?: DoubleClickDetector;
  /** Puts a row back as it was after a double click toggled it (V11.12). */
  readonly expansion?: Pick<ExpansionKeeper<TreeNode>, 'clicked'>;
  /** Opens the editable SQL of a column, index, key or routine (V11.12). */
  readonly openNodeSql?: (connectionId: string, target: NodeSqlTarget) => Promise<void>;
  /** Shows the actions of a node as a list (V11.12). */
  readonly showActions?: (node: TreeNode) => Promise<void>;
}

export type TreeCommandName =
  | 'connect'
  | 'disconnect'
  | 'refresh'
  | 'copyName'
  | 'openTable'
  | 'clickTable'
  | 'clickNode'
  | 'openNodeSql'
  | 'nodeActions'
  | 'showDefinition';

/** What a tree command receives: the clicked node, a bare id, or nothing. */
export type CommandTarget = TreeNode | string | undefined;

export function treeCommandHandlers(
  deps: TreeCommandDeps,
): Record<TreeCommandName, (target?: CommandTarget) => unknown> {
  const doubleClick = deps.doubleClick ?? new DoubleClickDetector();
  const requireConnectionId = (target: CommandTarget): string => {
    const connectionId = connectionIdOf(target);
    if (connectionId === undefined) {
      throw new DbError('not-found', deps.noTargetMessage);
    }
    return connectionId;
  };

  const openNodeSql = async (node: TreeNode): Promise<void> => {
    const sql = nodeSqlTargetOf(node);
    const connectionId = connectionIdOf(node);
    if (sql !== undefined && connectionId !== undefined) {
      await deps.openNodeSql?.(connectionId, sql);
    }
  };

  return {
    connect: async (target?: CommandTarget) => {
      await deps.manager.connectAny(requireConnectionId(target));
      deps.tree.refresh();
      return undefined;
    },

    disconnect: async (target?: CommandTarget) => {
      const connectionId = requireConnectionId(target);
      if (deps.confirmDisconnect !== undefined && !(await deps.confirmDisconnect(connectionId))) {
        return undefined;
      }
      await deps.manager.disconnect(connectionId);
      deps.tree.refresh();
      return undefined;
    },

    /**
     * Refreshes the clicked subtree, or everything when run from the view title.
     * The cached structure is dropped first: Refresh means "ask the server again";
     * the whole tree also reads the project files again, should a change on disk
     * have gone unnoticed.
     */
    refresh: async (target?: CommandTarget) => {
      const node = isTreeNode(target) ? target : undefined;
      deps.cache.invalidate(node === undefined ? undefined : connectionIdOf(node));
      if (node === undefined) {
        await deps.reloadProjects?.();
      }
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

    /** A click on a table: the second of a pair opens it, and the row stays as it was. */
    clickTable: async (target?: CommandTarget) => {
      if (!isTreeNode(target) || target.kind !== 'table') {
        return undefined;
      }
      deps.expansion?.clicked(target);
      if (doubleClick.click(nodeId(target))) {
        await deps.openTable(target);
      }
      return undefined;
    },

    /** A click on a column, index, key or routine: the second of a pair opens its SQL. */
    clickNode: async (target?: CommandTarget) => {
      if (!isTreeNode(target) || nodeSqlTargetOf(target) === undefined) {
        return undefined;
      }
      if (doubleClick.click(nodeId(target))) {
        await openNodeSql(target);
      }
      return undefined;
    },

    /** Opens the editable SQL of the node: its ALTER, CREATE or DROP statements. */
    openNodeSql: async (target?: CommandTarget) => {
      if (isTreeNode(target)) {
        await openNodeSql(target);
      }
      return undefined;
    },

    /** The actions of the node as a list: what its right-click menu offers. */
    nodeActions: async (target?: CommandTarget) => {
      if (isTreeNode(target)) {
        await deps.showActions?.(target);
      }
      return undefined;
    },

    /** Opens the DDL of a table, view or other object; folders and columns are ignored. */
    showDefinition: async (target?: CommandTarget) => {
      if (!isTreeNode(target)) {
        return undefined;
      }
      const object = objectRefOf(target);
      const connectionId = connectionIdOf(target);
      if (object !== undefined && connectionId !== undefined) {
        await deps.showDefinition(connectionId, object);
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
