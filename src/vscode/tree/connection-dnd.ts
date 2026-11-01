import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { Dialect } from '../../drivers/driver';
import type { ConnectionStore } from '../../services/connection-store';
import { CONFIG_KEYS, CONFIG_SECTION } from '../command-ids';
import { dragConnectionOf, dragTextOfAll, hasDragText } from './drag-text';
import { unwrapFavorite } from './favorites';
import { planDrop } from './drop-plan';
import { CONNECTIONS_VIEW_ID, isTreeNode, type TreeNode } from './nodes';

/** VS Code's own type for items dragged within a tree: `application/vnd.code.tree.<view id>`. */
export const CONNECTIONS_MIME = `application/vnd.code.tree.${CONNECTIONS_VIEW_ID.toLowerCase()}`;

/** What a text editor takes a drop as: the names are typed in (V13.4). */
const TEXT_MIME = 'text/plain';

/**
 * Drag connections into folders and around, and folders around; drag databases, schemas,
 * tables, views and columns into a text editor to type their quoted names (V13.4).
 */
export class ConnectionsDragAndDrop implements vscode.TreeDragAndDropController<TreeNode> {
  readonly dragMimeTypes = [CONNECTIONS_MIME, TEXT_MIME];
  readonly dropMimeTypes = [CONNECTIONS_MIME];

  constructor(
    private readonly store: ConnectionStore,
    private readonly logger: Logger,
    /** The dialect of a connection; absent turns dragging names off. */
    private readonly dialectOf?: (connectionId: string) => Promise<Dialect>,
  ) {}

  async handleDrag(source: readonly TreeNode[], data: vscode.DataTransfer): Promise<void> {
    await this.dragNames(source, data);
    this.dragMoves(source, data);
  }

  private async dragNames(source: readonly TreeNode[], data: vscode.DataTransfer): Promise<void> {
    const nodes = (unwrapFavorite([...source]) as TreeNode[]).filter(hasDragText);
    if (
      this.dialectOf === undefined ||
      nodes.length === 0 ||
      !vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>(CONFIG_KEYS.treeDragNames, true)
    ) {
      return;
    }
    const dialects = new Map<string, Dialect>();
    for (const node of nodes) {
      const connectionId = dragConnectionOf(node);
      if (connectionId !== undefined && !dialects.has(connectionId)) {
        try {
          dialects.set(connectionId, await this.dialectOf(connectionId));
        } catch (error) {
          // A connection that cannot say its dialect just drags nothing.
          this.logger.warn('Dragging names failed', error);
        }
      }
    }
    const text = dragTextOfAll(nodes, (id) => dialects.get(id));
    if (text !== '') {
      data.set(TEXT_MIME, new vscode.DataTransferItem(text));
    }
  }

  private dragMoves(source: readonly TreeNode[], data: vscode.DataTransfer): void {
    const movable = source.filter(
      (node) =>
        (node.kind === 'connection' && this.store.projectOf(node.connectionId) === undefined) ||
        node.kind === 'connectionFolder',
    );
    if (movable.length > 0) {
      data.set(CONNECTIONS_MIME, new vscode.DataTransferItem(movable));
    }
  }

  async handleDrop(target: TreeNode | undefined, data: vscode.DataTransfer): Promise<void> {
    const value: unknown = data.get(CONNECTIONS_MIME)?.value;
    const dragged = Array.isArray(value) ? value.filter(isTreeNode) : [];
    const plan = planDrop(
      dragged,
      target,
      (id) => this.store.get(id)?.folder,
      (id) => this.store.projectOf(id) !== undefined,
    );
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
