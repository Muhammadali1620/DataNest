import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ConnectionStore } from '../../services/connection-store';
import { planDrop } from './drop-plan';
import { CONNECTIONS_VIEW_ID, isTreeNode, type TreeNode } from './nodes';

/** VS Code's own type for items dragged within a tree: `application/vnd.code.tree.<view id>`. */
export const CONNECTIONS_MIME = `application/vnd.code.tree.${CONNECTIONS_VIEW_ID.toLowerCase()}`;

/** Drag connections into folders and around, and folders around. */
export class ConnectionsDragAndDrop implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dragMimeTypes = [CONNECTIONS_MIME];
  readonly dropMimeTypes = [CONNECTIONS_MIME];

  constructor(
    private readonly store: ConnectionStore,
    private readonly logger: Logger,
  ) {}

  handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): void {
    const movable = source.filter(
      (node) => node.kind === 'connection' || node.kind === 'connectionFolder',
    );
    if (movable.length > 0) {
      data.set(CONNECTIONS_MIME, new vscode.DataTransferItem(movable));
    }
  }

  async handleDrop(target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const value: unknown = data.get(CONNECTIONS_MIME)?.value;
    const dragged = Array.isArray(value) ? value.filter(isTreeNode) : [];
    const plan = planDrop(dragged, target, (id) => this.store.get(id)?.folder);
    try {
      if (plan?.kind === 'connections') {
        await this.store.moveConnections(plan.ids, plan.destination);
      } else if (plan?.kind === 'folder') {
        await this.store.moveFolder(plan.folder, plan.before);
      }
    } catch (error) {
      // A drop is a gesture; a failure is logged and shown, never thrown at the editor.
      this.logger.warn('Moving connections failed', error);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not move: {0}', errorMessage(error)),
      );
    }
  }
}
