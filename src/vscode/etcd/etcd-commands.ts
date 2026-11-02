// The tree commands of etcd connections (V13.19), free of `vscode`: what the dialogs ask
// comes in through `EtcdCommandUi`, so every path (a taken name, a refused delete, a
// production connection) is tested without an editor.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { EtcdKeyBrowser } from '../../services/etcd/key-browser';
import { ROOT } from '../../services/etcd/key-browser';
import {
  countPrefix,
  deleteEntry,
  deletePrefix,
  type EtcdCaller,
  putEntry,
} from '../../services/etcd/etcd-client';
import { findKeys } from '../../services/etcd/key-listing';
import type { ConnectionStore } from '../../services/connection-store';
import { changeVerdict, policyOf } from '../../services/write-policy';
import { type RedisKeyRef, redisKeyBytes, redisKeyRef } from '../../shared/redis-key';
import { connectionIdOf, isTreeNode, type TreeNode } from '../tree/nodes';
import type { CommandTarget } from '../tree/tree-commands';

/** Keys the search command lists at most. */
export const FIND_LIMIT = 200;

export interface EtcdCommandUi {
  /** Asks for text; undefined when the user backs out. */
  input(options: {
    readonly title: string;
    readonly prompt: string;
    readonly value?: string;
    readonly placeHolder?: string;
    /** Hides what is typed (V13.27). */
    readonly password?: boolean;
    readonly validate?: (value: string) => string | undefined;
  }): Promise<string | undefined>;
  /** Lets the user pick one of the keys; undefined when they back out. */
  pickKey(options: {
    readonly title: string;
    readonly keys: readonly RedisKeyRef[];
    readonly more: boolean;
  }): Promise<RedisKeyRef | undefined>;
  /** A modal question with one action; true when the user takes it. */
  confirm(message: string, detail: string | undefined, action: string): Promise<boolean>;
  /** Picks one of the connections; undefined when the user backs out. */
  pickConnection(ids: readonly string[]): Promise<string | undefined>;
  /** Tells the user something without asking. */
  info(message: string): void;
}

export interface EtcdCommandDeps {
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly browser: Pick<EtcdKeyBrowser, 'loadMore' | 'reset'>;
  /** The tree's session of a connection. */
  readonly session: (connectionId: string) => Promise<EtcdCaller>;
  readonly tree: { refresh(node?: TreeNode): void };
  readonly ui: EtcdCommandUi;
  /** Opens the page of a key; with `watchPrefix` it starts watching every key below it (V13.35). */
  readonly openKey: (
    connectionId: string,
    key: RedisKeyRef,
    options?: { readonly watchPrefix?: boolean },
  ) => Promise<void>;
  readonly texts: {
    readonly noEtcd: string;
    readonly readOnly: string;
  };
}

export type EtcdCommandName =
  'loadMoreKeys' | 'openKey' | 'findKey' | 'newKey' | 'deleteKeys' | 'watchPrefix';

export function etcdCommandHandlers(
  deps: EtcdCommandDeps,
): Record<EtcdCommandName, (target?: CommandTarget, ...rest: unknown[]) => unknown> {
  /** The connection of the clicked node, or one the user picks. */
  const connectionOf = async (target: CommandTarget): Promise<string | undefined> => {
    const given = connectionIdOf(target);
    if (given !== undefined) {
      if (deps.store.get(given)?.driver !== 'etcd') {
        throw new DbError('unsupported', deps.texts.noEtcd);
      }
      return given;
    }
    const all = deps.store.list().filter((config) => config.driver === 'etcd');
    if (all.length === 0) {
      throw new DbError('not-found', deps.texts.noEtcd);
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

  const parentOf = (connectionId: string, prefix: RedisKeyRef): TreeNode => {
    const text = prefix.text;
    if (text === '' && prefix.hex === undefined) {
      return { kind: 'connection', connectionId };
    }
    return { kind: 'etcdFolder', connectionId, prefix, name: text };
  };

  /** Where a node sits: the folder a new key starts in. */
  const folderOf = (target: CommandTarget): RedisKeyRef => {
    if (!isTreeNode(target)) {
      return ROOT;
    }
    if (target.kind === 'etcdFolder') {
      return target.prefix;
    }
    if (target.kind === 'etcdMore') {
      return target.prefix;
    }
    return ROOT;
  };

  return {
    loadMoreKeys: async (target?: CommandTarget) => {
      if (!isTreeNode(target) || target.kind !== 'etcdMore') {
        return undefined;
      }
      await deps.browser.loadMore(target.connectionId, target.prefix);
      deps.tree.refresh(parentOf(target.connectionId, target.prefix));
      return undefined;
    },

    openKey: async (target?: CommandTarget) => {
      if (isTreeNode(target) && target.kind === 'etcdKey') {
        await deps.openKey(target.connectionId, target.key);
      }
      return undefined;
    },

    /**
     * Follows every key below a folder (or the whole store, from the connection): the page
     * of the folder opens with the watch already running. Watching only reads, so a
     * read-only connection may do it.
     */
    watchPrefix: async (target?: CommandTarget) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      await deps.openKey(connectionId, folderOf(target), { watchPrefix: true });
      return undefined;
    },

    /** Searches by prefix: the cluster has no "contains", only ranges. */
    findKey: async (target?: CommandTarget) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      const start = folderOf(target).text;
      const typed = await deps.ui.input({
        title: msg('Find Key'),
        prompt: msg('The beginning of the key name; keys that start with it are listed'),
        value: start,
        placeHolder: '/app/config/',
      });
      if (typed === undefined) {
        return undefined;
      }
      const found = await findKeys(
        await deps.session(connectionId),
        new TextEncoder().encode(typed),
        FIND_LIMIT,
      );
      if (found.keys.length === 0) {
        deps.ui.info(msg('No keys start with "{0}"', typed));
        return undefined;
      }
      const key = await deps.ui.pickKey({
        title: msg('Keys starting with "{0}"', typed),
        keys: found.keys,
        more: found.more,
      });
      if (key !== undefined) {
        await deps.openKey(connectionId, key);
      }
      return undefined;
    },

    /** Makes a key with an empty value and opens its page to fill in. */
    newKey: async (target?: CommandTarget) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      requireWritable(connectionId);
      const name = await deps.ui.input({
        title: msg('New Key'),
        prompt: msg('The whole name of the key; a slash makes a folder'),
        value: folderOf(target).text,
        placeHolder: '/app/config/name',
        validate: (value) => (value === '' ? msg('A key needs a name') : undefined),
      });
      if (name === undefined || name === '') {
        return undefined;
      }
      const ref = redisKeyRef(new TextEncoder().encode(name));
      const result = await putEntry(await deps.session(connectionId), redisKeyBytes(ref), {
        value: new Uint8Array(),
        expect: { kind: 'absent' },
      });
      if (!result.done) {
        throw new DbError('constraint', msg('The key "{0}" already exists', name));
      }
      deps.browser.reset(connectionId);
      deps.tree.refresh();
      await deps.openKey(connectionId, ref);
      return undefined;
    },

    /**
     * Deletes the clicked key, every selected key, or everything under a folder — after
     * saying how many keys that is. A production connection says so in the question too.
     */
    deleteKeys: async (target?: CommandTarget, ...rest: unknown[]) => {
      if (!isTreeNode(target) || (target.kind !== 'etcdKey' && target.kind !== 'etcdFolder')) {
        return undefined;
      }
      const picked = Array.isArray(rest[0]) ? (rest[0] as unknown[]).filter(isTreeNode) : [];
      const nodes = (picked.some((node) => node === target) ? picked : [target]).filter(
        (node): node is Extract<TreeNode, { kind: 'etcdKey' | 'etcdFolder' }> =>
          (node.kind === 'etcdKey' || node.kind === 'etcdFolder') &&
          node.connectionId === target.connectionId,
      );
      const { connectionId } = target;
      requireWritable(connectionId);
      const session = await deps.session(connectionId);
      const sizes = await Promise.all(
        nodes.map(async (node) =>
          node.kind === 'etcdKey' ? 1 : await countPrefix(session, redisKeyBytes(node.prefix)),
        ),
      );
      const total = sizes.reduce((sum, size) => sum + size, 0);
      if (total === 0) {
        deps.ui.info(msg('There is nothing to delete'));
        deps.browser.reset(connectionId);
        deps.tree.refresh();
        return undefined;
      }
      const config = deps.store.get(connectionId);
      const only = nodes.length === 1 ? nodes[0] : undefined;
      const message =
        only?.kind === 'etcdKey'
          ? msg('Delete the key "{0}"?', only.key.text)
          : msg('Delete {0} keys?', total);
      const detail = [
        only?.kind === 'etcdFolder'
          ? msg('Every key that starts with "{0}" is deleted.', only.prefix.text)
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
        if (node.kind === 'etcdKey') {
          await deleteEntry(session, redisKeyBytes(node.key));
        } else {
          await deletePrefix(session, redisKeyBytes(node.prefix));
        }
      }
      deps.browser.reset(connectionId);
      deps.tree.refresh();
      return undefined;
    },
  };
}
