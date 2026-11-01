// What dropping tree items somewhere means: connections move into a folder or in
// front of another connection, a folder moves into another folder (V13.8) or next to
// the folder of a connection. Free of `vscode`, so every case is a unit test.

import type { MoveDestination } from '../../services/connection-store';
import { isInFolder, parentFolder } from '../../shared/folder-path';
import type { TreeNode } from './nodes';

export type DropPlan =
  | { readonly kind: 'connections'; readonly ids: string[]; readonly destination: MoveDestination }
  | {
      readonly kind: 'folder';
      readonly folder: string;
      /** The folder to go into; absent means the top level. */
      readonly parent?: string;
      /** A folder in that parent to go in front of; absent means last. */
      readonly before?: string;
    };

/**
 * `folderOf` tells which folder a connection is in (undefined: the top level), and
 * `inProject` whether it lives in a project file, whose order is the file's and which
 * has no folders (V4.7): such connections neither move nor take drops. Nothing happens
 * when a dragged item is dropped on itself or nothing movable is dragged.
 */
export function planDrop(
  dragged: readonly TreeNode[],
  target: TreeNode | undefined,
  folderOf: (connectionId: string) => string | undefined,
  inProject: (connectionId: string) => boolean = () => false,
): DropPlan | undefined {
  if (
    target?.kind === 'project' ||
    (target !== undefined &&
      'connectionId' in target &&
      target.connectionId !== undefined &&
      inProject(target.connectionId))
  ) {
    return undefined;
  }
  const folder = dragged.find((node) => node.kind === 'connectionFolder');
  if (folder !== undefined) {
    return planFolderDrop(folder.folder, target, folderOf);
  }
  const ids = dragged.flatMap((node) =>
    node.kind === 'connection' && !inProject(node.connectionId) ? [node.connectionId] : [],
  );
  if (ids.length === 0) {
    return undefined;
  }
  if (target === undefined) {
    return { kind: 'connections', ids, destination: {} };
  }
  if (target.kind === 'connectionFolder') {
    return { kind: 'connections', ids, destination: { folder: target.folder } };
  }
  if (target.kind === 'message' && target.folder !== undefined) {
    return { kind: 'connections', ids, destination: { folder: target.folder } };
  }
  // Anything inside a connection (a database, a table) stands for that connection.
  const anchor = 'connectionId' in target ? target.connectionId : undefined;
  if (anchor === undefined || ids.includes(anchor)) {
    return undefined;
  }
  const into = folderOf(anchor);
  return {
    kind: 'connections',
    ids,
    destination: { ...(into === undefined ? {} : { folder: into }), before: anchor },
  };
}

/**
 * A folder dropped on a folder (or its empty leaf) goes into it; dropped on a connection
 * it goes next to that connection's folder, in front of it; dropped on empty space or a
 * loose connection it goes last on the top level. Never into itself or what it holds.
 */
function planFolderDrop(
  folder: string,
  target: TreeNode | undefined,
  folderOf: (connectionId: string) => string | undefined,
): DropPlan | undefined {
  let into: string | undefined;
  let beside: string | undefined;
  if (target?.kind === 'connectionFolder') {
    into = target.folder;
  } else if (target?.kind === 'message') {
    into = target.folder;
  } else if (target !== undefined && 'connectionId' in target) {
    beside = folderOf(target.connectionId);
  }
  const reached = into ?? beside;
  if (reached !== undefined && isInFolder(reached, folder)) {
    return undefined;
  }
  if (into !== undefined) {
    return { kind: 'folder', folder, parent: into };
  }
  if (beside === undefined) {
    return { kind: 'folder', folder };
  }
  const parent = parentFolder(beside);
  return { kind: 'folder', folder, ...(parent === undefined ? {} : { parent }), before: beside };
}
