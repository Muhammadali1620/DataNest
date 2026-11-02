// The tree commands of ZooKeeper connections (V13.24), free of `vscode`: what the dialogs ask
// comes in through `ZookeeperCommandUi`, so every path (a taken name, a refused delete, a
// production connection) is tested without an editor.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { ZookeeperCreateMode } from '../../drivers/zookeeper-driver';
import type { ConnectionStore } from '../../services/connection-store';
import type { ZookeeperNodeBrowser } from '../../services/zookeeper/node-browser';
import { countTree, deleteTree, type ZookeeperCaller } from '../../services/zookeeper/zk-ops';
import { changeVerdict, policyOf } from '../../services/write-policy';
import { joinPath, nameOf, nameProblem, pathProblem, ROOT_PATH } from '../../shared/zk-path';
import { nameProblemText } from '../panels/zookeeper-node-model';
import { connectionIdOf, isTreeNode, type TreeNode } from '../tree/nodes';
import type { CommandTarget } from '../tree/tree-commands';

export interface ZookeeperCommandUi {
  /** Asks for text; undefined when the user backs out. */
  input(options: {
    readonly title: string;
    readonly prompt: string;
    readonly value?: string;
    readonly placeHolder?: string;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
  /** Asks how a new znode lives; undefined when the user backs out. */
  pickMode(): Promise<ZookeeperCreateMode | undefined>;
  /** A modal question with one action; true when the user takes it. */
  confirm(message: string, detail: string | undefined, action: string): Promise<boolean>;
  /** Picks one of the connections; undefined when the user backs out. */
  pickConnection(ids: readonly string[]): Promise<string | undefined>;
  /** Tells the user something without asking. */
  info(message: string): void;
}

export interface ZookeeperCommandDeps {
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly browser: Pick<ZookeeperNodeBrowser, 'loadMore' | 'reset'>;
  /** The tree's session of a connection. */
  readonly session: (connectionId: string) => Promise<ZookeeperCaller>;
  readonly tree: { refresh(node?: TreeNode): void };
  readonly ui: ZookeeperCommandUi;
  /** Opens the page of a znode. */
  readonly openNode: (connectionId: string, path: string) => Promise<void>;
  readonly texts: {
    readonly noZookeeper: string;
    readonly readOnly: string;
  };
}

export type ZookeeperCommandName =
  'loadMoreNodes' | 'openNode' | 'goToNode' | 'newNode' | 'deleteNodes';

export function zookeeperCommandHandlers(
  deps: ZookeeperCommandDeps,
): Record<ZookeeperCommandName, (target?: CommandTarget, ...rest: unknown[]) => unknown> {
  /** The connection of the clicked node, or one the user picks. */
  const connectionOf = async (target: CommandTarget): Promise<string | undefined> => {
    const given = connectionIdOf(target);
    if (given !== undefined) {
      if (deps.store.get(given)?.driver !== 'zookeeper') {
        throw new DbError('unsupported', deps.texts.noZookeeper);
      }
      return given;
    }
    const all = deps.store.list().filter((config) => config.driver === 'zookeeper');
    if (all.length === 0) {
      throw new DbError('not-found', deps.texts.noZookeeper);
    }
    return all.length === 1
      ? all[0]?.id
      : await deps.ui.pickConnection(all.map((config) => config.id));
  };

  /** Refuses a read-only connection; production asks later, with what is about to go. */
  const requireWritable = (connectionId: string): void => {
    if (changeVerdict(policyOf(deps.store.get(connectionId))) === 'refuse') {
      throw new DbError('permission-denied', deps.texts.readOnly);
    }
  };

  const nodeAt = (connectionId: string, path: string): TreeNode =>
    path === ROOT_PATH
      ? { kind: 'connection', connectionId }
      : { kind: 'zookeeperNode', connectionId, path, name: nameOf(path) };

  /** Where a node sits: the znode a new child starts under. */
  const parentOfTarget = (target: CommandTarget): string => {
    if (
      isTreeNode(target) &&
      (target.kind === 'zookeeperNode' || target.kind === 'zookeeperMore')
    ) {
      return target.path;
    }
    return ROOT_PATH;
  };

  return {
    loadMoreNodes: async (target?: CommandTarget) => {
      if (!isTreeNode(target) || target.kind !== 'zookeeperMore') {
        return undefined;
      }
      await deps.browser.loadMore(target.connectionId, target.path);
      deps.tree.refresh(nodeAt(target.connectionId, target.path));
      return undefined;
    },

    openNode: async (target?: CommandTarget) => {
      if (isTreeNode(target) && target.kind === 'zookeeperNode') {
        await deps.openNode(target.connectionId, target.path);
      }
      return undefined;
    },

    /** ZooKeeper cannot search by name: the user types the whole path of a znode. */
    goToNode: async (target?: CommandTarget) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      const typed = await deps.ui.input({
        title: msg('Go to Znode'),
        prompt: msg('The whole path of the znode, starting with a slash'),
        value: parentOfTarget(target) === ROOT_PATH ? '/' : `${parentOfTarget(target)}/`,
        placeHolder: '/app/config',
        validate: (value) =>
          pathProblem(value) === undefined
            ? undefined
            : msg('Not a path of a znode: it starts with "/" and has no empty part'),
      });
      if (typed === undefined) {
        return undefined;
      }
      const path = typed.length > 1 ? typed.replace(/\/+$/u, '') : typed;
      const session = await deps.session(connectionId);
      if ((await session.exists(path)) === undefined) {
        deps.ui.info(msg('There is no znode "{0}"', path));
        return undefined;
      }
      await deps.openNode(connectionId, path);
      return undefined;
    },

    /** Makes a child with empty data and opens its page to fill in. */
    newNode: async (target?: CommandTarget) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      requireWritable(connectionId);
      const parent = parentOfTarget(target);
      const name = await deps.ui.input({
        title: msg('New Znode'),
        prompt: msg('The name of the new znode below "{0}"; a slash makes no folders', parent),
        placeHolder: 'name',
        validate: (value) => {
          const problem = nameProblem(value);
          return problem === undefined ? undefined : nameProblemText(problem);
        },
      });
      if (name === undefined || name === '') {
        return undefined;
      }
      const mode = await deps.ui.pickMode();
      if (mode === undefined) {
        return undefined;
      }
      const session = await deps.session(connectionId);
      const config = deps.store.get(connectionId);
      if (
        config?.production === true &&
        !(await deps.ui.confirm(
          msg(
            'Create the znode "{0}" on the production connection "{1}"?',
            joinPath(parent, name),
            config.name,
          ),
          undefined,
          msg('Create'),
        ))
      ) {
        return undefined;
      }
      const created = await session.create(joinPath(parent, name), new Uint8Array(), mode);
      deps.browser.reset(connectionId);
      deps.tree.refresh();
      await deps.openNode(connectionId, created);
      return undefined;
    },

    /**
     * Deletes the clicked znode and everything below it, or every selected znode — after
     * saying how many znodes that is. A production connection says so in the question too.
     */
    deleteNodes: async (target?: CommandTarget, ...rest: unknown[]) => {
      if (!isTreeNode(target) || target.kind !== 'zookeeperNode') {
        return undefined;
      }
      const picked = Array.isArray(rest[0]) ? (rest[0] as unknown[]).filter(isTreeNode) : [];
      const nodes = (picked.some((node) => node === target) ? picked : [target]).filter(
        (node): node is Extract<TreeNode, { kind: 'zookeeperNode' }> =>
          node.kind === 'zookeeperNode' &&
          node.connectionId === target.connectionId &&
          node.path !== ROOT_PATH,
      );
      if (nodes.length === 0) {
        return undefined;
      }
      const { connectionId } = target;
      requireWritable(connectionId);
      const session = await deps.session(connectionId);
      const counts = await Promise.all(nodes.map((node) => countTree(session, node.path)));
      const total = counts.reduce((sum, one) => sum + one.count, 0);
      const capped = counts.some((one) => one.capped);
      const config = deps.store.get(connectionId);
      const only = nodes.length === 1 ? nodes[0] : undefined;
      const message =
        only !== undefined
          ? msg('Delete the znode "{0}"?', only.path)
          : msg('Delete {0} znodes and everything below them?', nodes.length);
      const detail = [
        total > nodes.length
          ? capped
            ? msg('At least {0} znodes in all go, with everything below.', total)
            : msg('{0} znodes in all go, with everything below.', total)
          : undefined,
        config?.production === true
          ? msg('"{0}" is a production connection.', config.name)
          : undefined,
      ]
        .filter((line): line is string => line !== undefined)
        .join(' ');
      if (!(await deps.ui.confirm(message, detail === '' ? undefined : detail, msg('Delete')))) {
        return undefined;
      }
      for (const node of nodes) {
        await deleteTree(session, node.path);
      }
      deps.browser.reset(connectionId);
      deps.tree.refresh();
      return undefined;
    },
  };
}
