import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import { modeOctal, parentPath } from '../../shared/remote-path';
import { describeServer, type SshServerConfig } from '../../shared/ssh-server';
import type { ServerStore } from '../../services/server-store';
import type { SftpHub } from '../../services/sftp-hub';
import { sortEntries } from '../../services/sftp-ops';
import type { SftpEntry } from '../../services/sftp-types';
import { COLOR_THEME_IDS } from '../tree/connection-look';
import {
  dateText,
  entryContext,
  entryDescription,
  entryNodeId,
  lookOf,
  SERVER_CONTEXT,
  SERVERS_VIEW_ID,
} from './server-model';

export { SERVERS_VIEW_ID };

export type ServerNode =
  | { readonly kind: 'server'; readonly serverId: string }
  | { readonly kind: 'entry'; readonly serverId: string; readonly entry: SftpEntry }
  | {
      readonly kind: 'message';
      readonly serverId: string;
      /** Where the message sits, so two of them do not share an id. */
      readonly under: string;
      readonly text: string;
      readonly failed: boolean;
    };

/** The folder a node stands for or lies in; `undefined` means the server's start folder. */
export function folderOf(node: ServerNode): { serverId: string; path: string | undefined } {
  if (node.kind === 'entry') {
    return {
      serverId: node.serverId,
      path: node.entry.kind === 'directory' ? node.entry.path : parentPath(node.entry.path),
    };
  }
  return { serverId: node.serverId, path: undefined };
}

export function isServerNode(value: unknown): value is ServerNode {
  const kind = (value as { kind?: unknown } | null)?.kind;
  return kind === 'server' || kind === 'entry' || kind === 'message';
}

export interface ServersTreeDeps {
  readonly store: ServerStore;
  readonly hub: SftpHub;
  /** Hidden files (names starting with a dot) are listed. */
  readonly showHidden: () => boolean;
  /** Files dropped on the tree from the explorer. */
  readonly onDropFiles: (target: ServerNode | undefined, paths: readonly string[]) => Promise<void>;
}

/** The "Servers" view: saved SSH servers, and the folders and files on them, listed lazily. */
export class ServersTree
  implements
    vscode.TreeDataProvider<ServerNode>,
    vscode.TreeDragAndDropController<ServerNode>,
    vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<ServerNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  readonly dropMimeTypes = ['text/uri-list'];
  readonly dragMimeTypes: string[] = [];
  private readonly subscriptions: { dispose(): void }[];

  constructor(private readonly deps: ServersTreeDeps) {
    this.subscriptions = [
      deps.store.onDidChange(() => {
        this.changed.fire(undefined);
      }),
      deps.hub.onDidChangeState(() => {
        this.changed.fire(undefined);
      }),
    ];
  }

  /** Draws a node (and what is under it) again; no node means the whole tree. */
  refresh(node?: ServerNode): void {
    this.changed.fire(node);
  }

  async getChildren(node?: ServerNode): Promise<ServerNode[]> {
    if (node === undefined) {
      return this.deps.store.list().map((server) => ({ kind: 'server', serverId: server.id }));
    }
    if (node.kind === 'message') {
      return [];
    }
    const path = node.kind === 'server' ? undefined : node.entry.path;
    if (node.kind === 'entry' && node.entry.kind !== 'directory') {
      return [];
    }
    try {
      const entries = await this.deps.hub.run(node.serverId, async (session) => {
        const start =
          path ?? this.deps.store.get(node.serverId)?.startPath ?? (await session.home());
        return await session.list(start);
      });
      const shown = this.deps.showHidden()
        ? entries
        : entries.filter((entry) => !entry.name.startsWith('.'));
      if (shown.length === 0) {
        return [this.message(node, vscode.l10n.t('This folder is empty'), false)];
      }
      return sortEntries(shown).map((entry) => ({
        kind: 'entry' as const,
        serverId: node.serverId,
        entry,
      }));
    } catch (error) {
      return [this.message(node, errorMessage(error), true)];
    }
  }

  getTreeItem(node: ServerNode): vscode.TreeItem {
    switch (node.kind) {
      case 'server':
        return this.serverItem(node);
      case 'entry':
        return this.entryItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.id = entryNodeId(node.serverId, `${node.under}\u0000message`);
        item.contextValue = SERVER_CONTEXT.message;
        item.iconPath = node.failed
          ? new vscode.ThemeIcon('error', new vscode.ThemeColor('list.errorForeground'))
          : new vscode.ThemeIcon('info', new vscode.ThemeColor('descriptionForeground'));
        item.tooltip = node.text;
        return item;
      }
    }
  }

  async handleDrop(
    target: ServerNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    const item = dataTransfer.get('text/uri-list');
    if (item === undefined) {
      return;
    }
    const paths = (await item.asString())
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .flatMap((line) => {
        try {
          const uri = vscode.Uri.parse(line);
          return uri.scheme === 'file' ? [uri.fsPath] : [];
        } catch {
          return [];
        }
      });
    if (paths.length > 0) {
      await this.deps.onDropFiles(target, paths);
    }
  }

  dispose(): void {
    for (const subscription of this.subscriptions) {
      subscription.dispose();
    }
    this.changed.dispose();
  }

  private message(parent: ServerNode, text: string, failed: boolean): ServerNode {
    return {
      kind: 'message',
      serverId: parent.serverId,
      under: parent.kind === 'entry' ? parent.entry.path : '',
      text,
      failed,
    };
  }

  private serverItem(node: Extract<ServerNode, { kind: 'server' }>): vscode.TreeItem {
    const server = this.deps.store.get(node.serverId);
    const item = new vscode.TreeItem(
      server?.name ?? node.serverId,
      vscode.TreeItemCollapsibleState.Collapsed,
    );
    item.id = entryNodeId(node.serverId, '');
    const open = this.deps.hub.isOpen(node.serverId);
    item.contextValue = open ? SERVER_CONTEXT.serverOpen : SERVER_CONTEXT.server;
    item.description = [
      server?.readOnly === true ? vscode.l10n.t('Read-only') : undefined,
      server === undefined ? undefined : describeServer(server),
    ]
      .filter((part) => part !== undefined)
      .join(' · ');
    item.iconPath = new vscode.ThemeIcon(
      open ? 'vm-active' : 'vm',
      new vscode.ThemeColor(
        open
          ? 'charts.green'
          : server?.color === undefined
            ? 'foreground'
            : COLOR_THEME_IDS[server.color],
      ),
    );
    item.tooltip = new vscode.MarkdownString(serverTooltip(server, open));
    return item;
  }

  private entryItem(node: Extract<ServerNode, { kind: 'entry' }>): vscode.TreeItem {
    const { entry } = node;
    const readOnly = this.deps.store.get(node.serverId)?.readOnly === true;
    const isFolder = entry.kind === 'directory';
    const item = new vscode.TreeItem(
      entry.name,
      isFolder ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.id = entryNodeId(node.serverId, entry.path);
    item.contextValue = entryContext(entry, readOnly);
    item.description = entryDescription(entry, vscode.env.language);
    const look = lookOf(entry);
    item.iconPath = new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color));
    item.tooltip = new vscode.MarkdownString(
      [
        `**${entry.name}**`,
        entry.path,
        `${modeOctal(entry.mode)}${entry.modified > 0 ? ` · ${dateText(entry.modified, vscode.env.language)}` : ''}`,
        entry.link ? vscode.l10n.t('A link') : '',
      ]
        .filter((line) => line !== '')
        .join('\n\n'),
    );
    if (!isFolder && entry.kind === 'file') {
      item.command = {
        command: 'datanest.sftp.open',
        title: vscode.l10n.t('Open'),
        arguments: [node],
      };
    }
    return item;
  }
}

function serverTooltip(server: SshServerConfig | undefined, open: boolean): string {
  if (server === undefined) {
    return '';
  }
  return [
    `**${server.name}**`,
    describeServer(server),
    server.startPath === undefined ? '' : vscode.l10n.t('Starts in {0}', server.startPath),
    server.readOnly === true ? vscode.l10n.t('Read-only: nothing on it may change') : '',
    open ? vscode.l10n.t('Connected') : vscode.l10n.t('Not connected'),
  ]
    .filter((line) => line !== '')
    .join('\n\n');
}
