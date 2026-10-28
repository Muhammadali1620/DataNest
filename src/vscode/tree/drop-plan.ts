// What dropping tree items somewhere means: connections move into a folder or in
// front of another connection, a folder moves in front of another folder. Free of
// `vscode`, so every case is a unit test.

import type { MoveDestination } from '../../services/connection-store';
import type { TreeNode } from './nodes';

export type DropPlan =
  | { readonly kind: 'connections'; readonly ids: string[]; readonly destination: MoveDestination }
  | { readonly kind: 'folder'; readonly folder: string; readonly before?: string };

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

function planFolderDrop(
  folder: string,
  target: TreeNode | undefined,
  folderOf: (connectionId: string) => string | undefined,
): DropPlan | undefined {
  let before: string | undefined;
  if (target?.kind === 'connectionFolder') {
    before = target.folder;
  } else if (
    target !== undefined &&
    'connectionId' in target &&
    target.connectionId !== undefined
  ) {
    before = folderOf(target.connectionId);
  } else if (target?.kind === 'message') {
    before = target.folder;
  }
  if (before === folder) {
    return undefined;
  }
  return { kind: 'folder', folder, ...(before === undefined ? {} : { before }) };
}
