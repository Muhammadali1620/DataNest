import { basename, join } from 'node:path';
import { stat as statLocal } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import { DbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { msg } from '../../core/user-message';
import { formatSize } from '../../shared/byte-size';
import { fileKindOf, opensAsText } from '../../shared/file-kind';
import {
  baseName,
  isValidName,
  joinRemote,
  modeOctal,
  parentPath,
  parseMode,
} from '../../shared/remote-path';
import { describeServer, type SshServerConfig } from '../../shared/ssh-server';
import { exportServers, parseServerFile } from '../../services/server-transfer';
import type { ServerStore } from '../../services/server-store';
import type { SftpHub } from '../../services/sftp-hub';
import {
  changeAttributes,
  copyTree,
  createEmptyFile,
  downloadTree,
  entryAt,
  exists,
  moveEntry,
  moveTree,
  type MoveOutcome,
  removeTree,
  type TransferControl,
  uploadTree,
} from '../../services/sftp-ops';
import { NO_OWNER_NAMES, ownerText, resolveOwner } from '../../services/sftp-owners';
import type { SftpEntry } from '../../services/sftp-types';
import { askServer } from './server-wizard';
import { sftpUriParts } from './server-model';
import { folderOf, isServerNode, type ServerNode, type ServersTree } from './servers-tree';

export interface ServerCommandDeps {
  readonly store: ServerStore;
  readonly hub: SftpHub;
  readonly tree: ServersTree;
  readonly logger: Logger;
  /** The largest file that opens in the editor, in bytes. */
  readonly maxOpenBytes: () => number;
}

export type ServerCommandName =
  | 'addServer'
  | 'editServer'
  | 'removeServer'
  | 'disconnectServer'
  | 'toggleServerReadOnly'
  | 'refreshServers'
  | 'exportServers'
  | 'importServers'
  | 'open'
  | 'upload'
  | 'uploadFolder'
  | 'download'
  | 'rename'
  | 'delete'
  | 'newFolder'
  | 'newFile'
  | 'chmod'
  | 'chmodTree'
  | 'chown'
  | 'compareWithLocal'
  | 'compareWithServerFile'
  | 'copyPath'
  | 'copyTo'
  | 'moveTo'
  | 'refresh';

type Entry = Extract<ServerNode, { kind: 'entry' }>;

type Handler = (...args: unknown[]) => unknown;

export interface ServerCommands {
  readonly handlers: Record<ServerCommandName, Handler>;
  /** Files dropped on the tree from the explorer. */
  readonly drop: (target: ServerNode | undefined, paths: readonly string[]) => Promise<void>;
  /** Items of the tree dragged onto a folder or a server: moved there. */
  readonly moveEntries: (
    target: ServerNode | undefined,
    entries: readonly Entry[],
  ) => Promise<void>;
}

export function serverCommandHandlers(deps: ServerCommandDeps): ServerCommands {
  const serverOf = (id: string): SshServerConfig => {
    const server = deps.store.get(id);
    if (server === undefined) {
      throw new DbError('not-found', msg('The server "{0}" does not exist', id));
    }
    return server;
  };

  /** Writing is refused here too, whatever the menus show. */
  const requireWritable = (serverId: string): SshServerConfig => {
    const server = serverOf(serverId);
    if (server.readOnly === true) {
      throw new DbError(
        'permission-denied',
        msg('The server "{0}" is read-only: nothing on it may change', server.name),
      );
    }
    return server;
  };

  const startFolder = async (serverId: string): Promise<string> => {
    const server = serverOf(serverId);
    return server.startPath ?? (await deps.hub.run(serverId, (session) => session.home()));
  };

  /** The folder a node stands for; the start folder of a server. */
  const folderPathOf = async (node: ServerNode): Promise<{ serverId: string; path: string }> => {
    const folder = folderOf(node);
    return { serverId: folder.serverId, path: folder.path ?? (await startFolder(folder.serverId)) };
  };

  const entryNodes = (node: unknown, selected: unknown): Entry[] => {
    const chosen = Array.isArray(selected) ? selected.filter(isServerNode) : [];
    const nodes = chosen.length > 0 && chosen.some((item) => item === node) ? chosen : [node];
    return nodes.filter((item): item is Entry => isServerNode(item) && item.kind === 'entry');
  };

  const oneEntry = (node: unknown): Entry => {
    const found = entryNodes(node, undefined)[0];
    if (found === undefined) {
      throw new DbError('not-found', msg('Pick a file or a folder in the Servers view'));
    }
    return found;
  };

  const oneServer = async (node: unknown, placeHolder: string): Promise<string | undefined> => {
    if (isServerNode(node)) {
      return node.serverId;
    }
    const servers = deps.store.list();
    if (servers.length === 0) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There are no saved servers yet'));
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(
      servers.map((server) => ({
        label: server.name,
        description: describeServer(server),
        id: server.id,
      })),
      { placeHolder },
    );
    return picked?.id;
  };

  /** A cancellable progress notification around a transfer. */
  const transferring = async <T>(
    title: string,
    run: (control: TransferControl) => Promise<T>,
  ): Promise<T> =>
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => {
          abort.abort();
        });
        let reported = 0;
        return await run({
          signal: abort.signal,
          onProgress: (state) => {
            const now = Date.now();
            if (now - reported < 120) {
              return;
            }
            reported = now;
            progress.report({
              message: vscode.l10n.t(
                '{0} files · {1} · {2}',
                state.files,
                formatSize(state.bytes),
                baseName(state.current),
              ),
            });
          },
        });
      },
    );

  const summary = (result: {
    files: number;
    folders: number;
    bytes: number;
    skipped: number;
  }): string =>
    result.skipped > 0
      ? vscode.l10n.t(
          '{0} files, {1}; {2} links and special files were not copied',
          result.files,
          formatSize(result.bytes),
          result.skipped,
        )
      : vscode.l10n.t('{0} files, {1}', result.files, formatSize(result.bytes));

  /** Asks once before replacing anything that is already there. */
  const confirmReplace = async (names: readonly string[]): Promise<boolean> => {
    if (names.length === 0) {
      return true;
    }
    const replace = vscode.l10n.t('Replace');
    const answer = await vscode.window.showWarningMessage(
      names.length === 1
        ? vscode.l10n.t('"{0}" already exists. Replace it?', names[0] ?? '')
        : vscode.l10n.t('{0} items already exist. Replace them?', names.length),
      { modal: true, detail: names.slice(0, 8).join('\n') },
      replace,
    );
    return answer === replace;
  };

  const uploadPaths = async (
    serverId: string,
    folder: string,
    paths: readonly string[],
  ): Promise<void> => {
    requireWritable(serverId);
    if (paths.length === 0) {
      return;
    }
    const targets = paths.map((path) => ({ path, remote: joinRemote(folder, basename(path)) }));
    const taken = await deps.hub.run(serverId, async (session) => {
      const names: string[] = [];
      for (const target of targets) {
        if (await exists(session, target.remote)) {
          names.push(basename(target.path));
        }
      }
      return names;
    });
    if (!(await confirmReplace(taken))) {
      return;
    }
    const result = await transferring(vscode.l10n.t('Uploading to the server…'), (control) =>
      deps.hub.run(serverId, async (session) => {
        const total = { files: 0, folders: 0, bytes: 0, skipped: 0 };
        for (const target of targets) {
          const part = await uploadTree(session, target.path, target.remote, control);
          total.files += part.files;
          total.folders += part.folders;
          total.bytes += part.bytes;
          total.skipped += part.skipped;
        }
        return total;
      }),
    );
    void vscode.window.showInformationMessage(vscode.l10n.t('Uploaded: {0}', summary(result)));
    deps.tree.refresh();
  };

  const confirmOpenAnyway = async (entry: SftpEntry, node: unknown): Promise<boolean> => {
    const kind = fileKindOf(entry.name);
    if (opensAsText(kind)) {
      return true;
    }
    const open = vscode.l10n.t('Open Anyway');
    const answer = await vscode.window.showWarningMessage(
      vscode.l10n.t('"{0}" does not look like a text file.', entry.name),
      {
        modal: true,
        detail: vscode.l10n.t('Download it instead, or open it in the editor anyway.'),
      },
      open,
      vscode.l10n.t('Download'),
    );
    if (answer === vscode.l10n.t('Download')) {
      await vscode.commands.executeCommand('datanest.sftp.download', node);
      return false;
    }
    return answer === open;
  };

  /** Moves one item to a full path on a server, the same or another. */
  const moveOne = async (
    fromServer: string,
    entry: SftpEntry,
    toServer: string,
    toPath: string,
    control: TransferControl,
  ): Promise<MoveOutcome> =>
    await deps.hub.run(fromServer, async (from) => {
      const found = (await entryAt(from, entry.path)) ?? entry;
      if (toServer === fromServer) {
        return await moveTree(from, found, from, toPath, control);
      }
      return await deps.hub.run(toServer, (to) => moveTree(from, found, to, toPath, control));
    });

  /** Between servers a move is a copy and a delete: say so before it starts. */
  const confirmCrossMove = async (names: readonly string[], target: string): Promise<boolean> => {
    const move = vscode.l10n.t('Move');
    const answer = await vscode.window.showWarningMessage(
      names.length === 1
        ? vscode.l10n.t('Move "{0}" to the server "{1}"?', names[0] ?? '', target)
        : vscode.l10n.t('Move {0} items to the server "{1}"?', names.length, target),
      {
        modal: true,
        detail: vscode.l10n.t(
          'The files are copied first; the originals are deleted from their server only after every file arrived.',
        ),
      },
      move,
    );
    return answer === move;
  };

  const reportMoves = (outcomes: readonly MoveOutcome[]): void => {
    const kept = outcomes.filter((outcome) => !outcome.sourceRemoved).length;
    if (kept > 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t(
          'Copied, but {0} originals were kept: they hold links or special files that were not copied.',
          kept,
        ),
      );
    }
  };

  const moveEntries = async (
    target: ServerNode | undefined,
    entries: readonly Entry[],
  ): Promise<void> => {
    if (target === undefined) {
      return;
    }
    const folder = await folderPathOf(target);
    // Already in that folder, or the folder itself: nothing to do.
    const items = entries.filter(
      (item) =>
        !(
          item.serverId === folder.serverId &&
          (parentPath(item.entry.path) === folder.path || item.entry.path === folder.path)
        ),
    );
    if (items.length === 0) {
      return;
    }
    requireWritable(folder.serverId);
    for (const id of new Set(items.map((item) => item.serverId))) {
      requireWritable(id);
    }
    if (
      items.some((item) => item.serverId !== folder.serverId) &&
      !(await confirmCrossMove(
        items.map((item) => item.entry.name),
        serverOf(folder.serverId).name,
      ))
    ) {
      return;
    }
    try {
      const outcomes = await transferring(vscode.l10n.t('Moving…'), async (control) => {
        const done: MoveOutcome[] = [];
        for (const item of items) {
          done.push(
            await moveOne(
              item.serverId,
              item.entry,
              folder.serverId,
              joinRemote(folder.path, item.entry.name),
              control,
            ),
          );
        }
        return done;
      });
      reportMoves(outcomes);
    } finally {
      deps.tree.refresh();
    }
  };

  const drop = async (target: ServerNode | undefined, paths: readonly string[]): Promise<void> => {
    if (target === undefined) {
      const only = deps.store.list();
      if (only.length !== 1 || only[0] === undefined) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Drop the files on a server or a folder in the Servers view.'),
        );
        return;
      }
      await uploadPaths(only[0].id, await startFolder(only[0].id), paths);
      return;
    }
    const folder = await folderPathOf(target);
    await uploadPaths(folder.serverId, folder.path, paths);
  };

  const handlers: Record<ServerCommandName, Handler> = {
    addServer: async () => {
      const answers = await askServer();
      if (answers === undefined) {
        return undefined;
      }
      const added = await deps.store.add(answers.input, answers.secrets, answers.proxyPassword);
      deps.tree.refresh();
      return added.id;
    },

    editServer: async (node?: unknown) => {
      const id = await oneServer(node, vscode.l10n.t('Pick a server to edit'));
      if (id === undefined) {
        return undefined;
      }
      const server = serverOf(id);
      const answers = await askServer(server);
      if (answers === undefined) {
        return undefined;
      }
      // The saved login must not outlive the settings it was made for.
      deps.hub.disconnect(id);
      await deps.store.update(id, answers.input, answers.changes, answers.proxyChange);
      return id;
    },

    removeServer: async (node?: unknown) => {
      const id = await oneServer(node, vscode.l10n.t('Pick a server to delete'));
      if (id === undefined) {
        return undefined;
      }
      const server = serverOf(id);
      const remove = vscode.l10n.t('Delete');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('Delete the server "{0}"?', server.name),
        {
          modal: true,
          detail: vscode.l10n.t(
            'Only the saved login is removed. Nothing on the server itself is touched.',
          ),
        },
        remove,
      );
      if (answer !== remove) {
        return undefined;
      }
      deps.hub.disconnect(id);
      await deps.store.remove(id);
      return undefined;
    },

    disconnectServer: (node?: unknown) => {
      if (isServerNode(node)) {
        deps.hub.disconnect(node.serverId);
      }
    },

    toggleServerReadOnly: async (node?: unknown) => {
      const id = await oneServer(node, vscode.l10n.t('Pick a server'));
      if (id === undefined) {
        return undefined;
      }
      const server = serverOf(id);
      await deps.store.setReadOnly(id, server.readOnly !== true);
      return undefined;
    },

    refreshServers: () => {
      deps.tree.refresh();
    },

    exportServers: async () => {
      const servers = deps.store.list();
      if (servers.length === 0) {
        void vscode.window.showInformationMessage(vscode.l10n.t('There are no saved servers yet'));
        return undefined;
      }
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(join(process.cwd(), 'datanest-servers.json')),
        filters: { JSON: ['json'] },
        title: vscode.l10n.t('Export servers'),
      });
      if (target === undefined) {
        return undefined;
      }
      await writeFile(target.fsPath, exportServers(servers), 'utf8');
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          '{0} servers saved without passwords. Enter them again after importing.',
          servers.length,
        ),
      );
      return undefined;
    },

    importServers: async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        filters: { JSON: ['json'] },
        title: vscode.l10n.t('Import servers'),
      });
      const file = picked?.[0];
      if (file === undefined) {
        return undefined;
      }
      const plan = parseServerFile(await readFile(file.fsPath, 'utf8'));
      const known = new Set(deps.store.list().map((server) => server.name));
      let added = 0;
      for (const input of plan.servers) {
        // A name already taken gets a suffix: nothing saved is replaced.
        let name = input.name;
        for (let n = 2; known.has(name); n += 1) {
          name = `${input.name} (${n})`;
        }
        known.add(name);
        await deps.store.add({ ...input, name });
        added += 1;
      }
      void vscode.window.showInformationMessage(
        plan.skipped.length === 0
          ? vscode.l10n.t('{0} servers added. Enter their passwords when you connect.', added)
          : vscode.l10n.t('{0} servers added, {1} skipped.', added, plan.skipped.length),
      );
      return undefined;
    },

    open: async (node?: unknown) => {
      const { entry, serverId } = oneEntry(node);
      if (entry.kind !== 'file') {
        return undefined;
      }
      if (entry.size > deps.maxOpenBytes()) {
        const download = vscode.l10n.t('Download');
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            '"{0}" is {1}, more than the {2} that open in the editor.',
            entry.name,
            formatSize(entry.size),
            formatSize(deps.maxOpenBytes()),
          ),
          download,
        );
        if (answer === download) {
          await vscode.commands.executeCommand('datanest.sftp.download', node);
        }
        return undefined;
      }
      if (!(await confirmOpenAnyway(entry, node))) {
        return undefined;
      }
      const parts = sftpUriParts(serverId, entry.path);
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.from(parts));
      return undefined;
    },

    upload: async (node?: unknown) => {
      const target = isServerNode(node) ? await folderPathOf(node) : undefined;
      if (target === undefined) {
        return undefined;
      }
      requireWritable(target.serverId);
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: vscode.l10n.t('Upload'),
        title: vscode.l10n.t('Upload files to {0}', target.path),
      });
      if (picked !== undefined && picked.length > 0) {
        await uploadPaths(
          target.serverId,
          target.path,
          picked.map((uri) => uri.fsPath),
        );
      }
      return undefined;
    },

    uploadFolder: async (node?: unknown) => {
      const target = isServerNode(node) ? await folderPathOf(node) : undefined;
      if (target === undefined) {
        return undefined;
      }
      requireWritable(target.serverId);
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: vscode.l10n.t('Upload'),
        title: vscode.l10n.t('Upload folders to {0}', target.path),
      });
      if (picked !== undefined && picked.length > 0) {
        await uploadPaths(
          target.serverId,
          target.path,
          picked.map((uri) => uri.fsPath),
        );
      }
      return undefined;
    },

    download: async (node?: unknown, selected?: unknown) => {
      const items = entryNodes(node, selected);
      if (items.length === 0) {
        return undefined;
      }
      const folder = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: vscode.l10n.t('Download Here'),
        title: vscode.l10n.t('Download to…'),
      });
      const base = folder?.[0]?.fsPath;
      if (base === undefined) {
        return undefined;
      }
      const taken: string[] = [];
      for (const item of items) {
        const local = join(base, item.entry.name);
        if (
          await statLocal(local).then(
            () => true,
            () => false,
          )
        ) {
          taken.push(item.entry.name);
        }
      }
      if (!(await confirmReplace(taken))) {
        return undefined;
      }
      const serverId = items[0]?.serverId ?? '';
      const result = await transferring(vscode.l10n.t('Downloading from the server…'), (control) =>
        deps.hub.run(serverId, async (session) => {
          const total = { files: 0, folders: 0, bytes: 0, skipped: 0 };
          for (const item of items) {
            const part = await downloadTree(
              session,
              item.entry.path,
              join(base, item.entry.name),
              control,
            );
            total.files += part.files;
            total.folders += part.folders;
            total.bytes += part.bytes;
            total.skipped += part.skipped;
          }
          return total;
        }),
      );
      const reveal = vscode.l10n.t('Show in Folder');
      const answer = await vscode.window.showInformationMessage(
        vscode.l10n.t('Downloaded: {0}', summary(result)),
        reveal,
      );
      if (answer === reveal) {
        await vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(join(base, items[0]?.entry.name ?? '')),
        );
      }
      return undefined;
    },

    rename: async (node?: unknown) => {
      const { serverId, entry } = oneEntry(node);
      requireWritable(serverId);
      const name = await vscode.window.showInputBox({
        title: vscode.l10n.t('Rename'),
        value: entry.name,
        valueSelection: [
          0,
          entry.name.lastIndexOf('.') > 0 ? entry.name.lastIndexOf('.') : entry.name.length,
        ],
        validateInput: (value) =>
          isValidName(value) ? undefined : vscode.l10n.t('A name cannot be empty or contain "/"'),
      });
      if (name === undefined || name === entry.name) {
        return undefined;
      }
      await deps.hub.run(serverId, (session) =>
        moveEntry(session, entry, joinRemote(parentPath(entry.path), name)),
      );
      deps.tree.refresh();
      return undefined;
    },

    delete: async (node?: unknown, selected?: unknown) => {
      const items = entryNodes(node, selected);
      const first = items[0];
      if (first === undefined) {
        return undefined;
      }
      requireWritable(first.serverId);
      const remove = vscode.l10n.t('Delete');
      const folders = items.some((item) => item.entry.kind === 'directory');
      const answer = await vscode.window.showWarningMessage(
        items.length === 1
          ? vscode.l10n.t('Delete "{0}" from the server?', first.entry.name)
          : vscode.l10n.t('Delete {0} items from the server?', items.length),
        {
          modal: true,
          detail: [
            items
              .slice(0, 8)
              .map((item) => item.entry.path)
              .join('\n'),
            folders ? vscode.l10n.t('Folders are deleted with everything in them.') : '',
            vscode.l10n.t('This cannot be undone.'),
          ]
            .filter((line) => line !== '')
            .join('\n\n'),
        },
        remove,
      );
      if (answer !== remove) {
        return undefined;
      }
      const removed = await transferring(vscode.l10n.t('Deleting…'), (control) =>
        deps.hub.run(first.serverId, async (session) => {
          let count = 0;
          for (const item of items) {
            count += await removeTree(session, item.entry, control);
          }
          return count;
        }),
      );
      void vscode.window.showInformationMessage(vscode.l10n.t('Deleted: {0} items', removed));
      deps.tree.refresh();
      return undefined;
    },

    newFolder: async (node?: unknown) => {
      if (!isServerNode(node)) {
        return undefined;
      }
      const { serverId, path } = await folderPathOf(node);
      requireWritable(serverId);
      const name = await vscode.window.showInputBox({
        title: vscode.l10n.t('New folder in {0}', path),
        validateInput: (value) =>
          isValidName(value) ? undefined : vscode.l10n.t('A name cannot be empty or contain "/"'),
      });
      if (name === undefined) {
        return undefined;
      }
      await deps.hub.run(serverId, (session) => session.mkdir(joinRemote(path, name)));
      deps.tree.refresh();
      return undefined;
    },

    newFile: async (node?: unknown) => {
      if (!isServerNode(node)) {
        return undefined;
      }
      const { serverId, path } = await folderPathOf(node);
      requireWritable(serverId);
      const name = await vscode.window.showInputBox({
        title: vscode.l10n.t('New file in {0}', path),
        validateInput: (value) =>
          isValidName(value) ? undefined : vscode.l10n.t('A name cannot be empty or contain "/"'),
      });
      if (name === undefined) {
        return undefined;
      }
      const remote = joinRemote(path, name);
      await deps.hub.run(serverId, (session) => createEmptyFile(session, remote));
      deps.tree.refresh();
      await vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.from(sftpUriParts(serverId, remote)),
      );
      return undefined;
    },

    chmod: async (node?: unknown) => {
      const { serverId, entry } = oneEntry(node);
      requireWritable(serverId);
      const text = await vscode.window.showInputBox({
        title: vscode.l10n.t('Permissions of {0}', entry.name),
        prompt: vscode.l10n.t('Octal, e.g. 644 for rw-r--r-- or 755 for rwxr-xr-x'),
        value: modeOctal(entry.mode),
        validateInput: (value) =>
          parseMode(value) === undefined
            ? vscode.l10n.t('Three or four octal digits, like 644 or 0755')
            : undefined,
      });
      const mode = text === undefined ? undefined : parseMode(text);
      if (mode === undefined) {
        return undefined;
      }
      await deps.hub.run(serverId, (session) => session.chmod(entry.path, mode));
      deps.tree.refresh();
      return undefined;
    },

    copyPath: async (node?: unknown, selected?: unknown) => {
      const items = entryNodes(node, selected);
      if (items.length > 0) {
        await vscode.env.clipboard.writeText(items.map((item) => item.entry.path).join('\n'));
      }
      return undefined;
    },

    copyTo: async (node?: unknown) => {
      const { serverId, entry } = oneEntry(node);
      const destination = await askDestination(deps, serverId, entry, vscode.l10n.t('Copy to'));
      if (destination === undefined) {
        return undefined;
      }
      requireWritable(destination.serverId);
      const result = await transferring(vscode.l10n.t('Copying…'), (control) =>
        deps.hub.run(serverId, async (from) =>
          deps.hub.run(destination.serverId, async (to) => {
            if (await exists(to, destination.path)) {
              throw new DbError(
                'unsupported',
                msg('{0} already exists on the server', destination.path),
              );
            }
            return await copyTree(from, entry, to, destination.path, control);
          }),
        ),
      );
      void vscode.window.showInformationMessage(vscode.l10n.t('Copied: {0}', summary(result)));
      deps.tree.refresh();
      return undefined;
    },

    moveTo: async (node?: unknown) => {
      const { serverId, entry } = oneEntry(node);
      requireWritable(serverId);
      const destination = await askDestination(deps, serverId, entry, vscode.l10n.t('Move to'));
      if (destination === undefined) {
        return undefined;
      }
      requireWritable(destination.serverId);
      if (
        destination.serverId !== serverId &&
        !(await confirmCrossMove([entry.name], serverOf(destination.serverId).name))
      ) {
        return undefined;
      }
      try {
        const outcome = await transferring(vscode.l10n.t('Moving…'), (control) =>
          moveOne(serverId, entry, destination.serverId, destination.path, control),
        );
        reportMoves([outcome]);
      } finally {
        deps.tree.refresh();
      }
      return undefined;
    },

    chmodTree: async (node?: unknown) => {
      const { serverId, entry } = oneEntry(node);
      requireWritable(serverId);
      if (entry.kind !== 'directory') {
        return undefined;
      }
      const ask = async (title: string, value: string): Promise<number | null | undefined> => {
        const text = await vscode.window.showInputBox({
          title,
          prompt: vscode.l10n.t('Octal, e.g. {0}. Leave empty to keep as it is.', value),
          value,
          validateInput: (input) =>
            input.trim() === '' || parseMode(input) !== undefined
              ? undefined
              : vscode.l10n.t('Three or four octal digits, like 644 or 0755'),
        });
        return text === undefined ? undefined : text.trim() === '' ? null : parseMode(text);
      };
      const fileMode = await ask(
        vscode.l10n.t('Permissions of the files in {0}', entry.name),
        '644',
      );
      if (fileMode === undefined) {
        return undefined;
      }
      const folderMode = await ask(
        vscode.l10n.t('Permissions of the folders in {0}', entry.name),
        '755',
      );
      if (folderMode === undefined || (fileMode === null && folderMode === null)) {
        return undefined;
      }
      const change = vscode.l10n.t('Change');
      const answer = await vscode.window.showWarningMessage(
        vscode.l10n.t('Change permissions of everything inside "{0}"?', entry.name),
        {
          modal: true,
          detail: [
            fileMode === null ? '' : vscode.l10n.t('Files: {0}', modeOctal(fileMode)),
            folderMode === null
              ? ''
              : vscode.l10n.t('Folders: {0} (and "{1}" itself)', modeOctal(folderMode), entry.name),
            vscode.l10n.t('Links are left alone.'),
          ]
            .filter((line) => line !== '')
            .join('\n'),
        },
        change,
      );
      if (answer !== change) {
        return undefined;
      }
      const result = await transferring(vscode.l10n.t('Changing permissions…'), (control) =>
        deps.hub.run(serverId, (session) =>
          changeAttributes(
            session,
            entry,
            {
              ...(fileMode === null ? {} : { fileMode }),
              ...(folderMode === null ? {} : { folderMode }),
            },
            true,
            control,
          ),
        ),
      );
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Permissions changed: {0} items, {1} links skipped',
          result.changed,
          result.skipped,
        ),
      );
      deps.tree.refresh();
      return undefined;
    },

    chown: async (node?: unknown) => {
      const { serverId, entry } = oneEntry(node);
      requireWritable(serverId);
      // The server's own names for users and groups, when it lets them be read.
      const names = await deps.hub.ownerNames(serverId).catch(() => NO_OWNER_NAMES);
      const problem = (value: string): string | undefined => {
        const found = resolveOwner(value, names);
        if (found === undefined) {
          return vscode.l10n.t('Give ids or names, like 1000:1000 or deploy:www');
        }
        if ('unknown' in found) {
          return found.unknown === 'user'
            ? vscode.l10n.t('The server has no user "{0}"', found.name)
            : vscode.l10n.t('The server has no group "{0}"', found.name);
        }
        return undefined;
      };
      const text = await vscode.window.showInputBox({
        title: vscode.l10n.t('Owner of {0}', entry.name),
        prompt: vscode.l10n.t(
          'User and group as user:group, by name or by number, e.g. deploy:www or 1000:1000. Only the user, deploy, or only the group, :www, also work.',
        ),
        value: ownerText(entry.uid, entry.gid, names),
        validateInput: problem,
      });
      const found = text === undefined ? undefined : resolveOwner(text, names);
      if (found === undefined || 'unknown' in found) {
        return undefined;
      }
      const owner = found;
      let recursive = false;
      if (entry.kind === 'directory') {
        const scope = await vscode.window.showQuickPick(
          [
            { label: vscode.l10n.t('Only this folder'), recursive: false },
            { label: vscode.l10n.t('Everything inside it too'), recursive: true },
          ],
          { title: vscode.l10n.t('Owner of {0}', entry.name) },
        );
        if (scope === undefined) {
          return undefined;
        }
        recursive = scope.recursive;
      }
      const result = await transferring(vscode.l10n.t('Changing the owner…'), (control) =>
        deps.hub.run(serverId, (session) =>
          changeAttributes(session, entry, owner, recursive, control),
        ),
      );
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'Owner changed: {0} items, {1} links skipped',
          result.changed,
          result.skipped,
        ),
      );
      deps.tree.refresh();
      return undefined;
    },

    compareWithLocal: async (node?: unknown) => {
      const { entry, serverId } = oneEntry(node);
      if (entry.kind !== 'file') {
        return undefined;
      }
      if (entry.size > deps.maxOpenBytes() || !opensAsText(fileKindOf(entry.name))) {
        throw new DbError(
          'unsupported',
          msg('"{0}" is too large or not a text file, so it is not compared', entry.name),
        );
      }
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: vscode.l10n.t('Compare'),
        title: vscode.l10n.t('Compare "{0}" with a file of this machine', entry.name),
      });
      const local = picked?.[0];
      if (local === undefined) {
        return undefined;
      }
      if ((await statLocal(local.fsPath)).size > deps.maxOpenBytes()) {
        throw new DbError(
          'unsupported',
          msg('"{0}" is too large to compare', basename(local.fsPath)),
        );
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        local,
        vscode.Uri.from(sftpUriParts(serverId, entry.path)),
        vscode.l10n.t('{0} ↔ {1} on the server', basename(local.fsPath), entry.name),
      );
      return undefined;
    },

    compareWithServerFile: async (node?: unknown) => {
      const { entry, serverId } = oneEntry(node);
      if (entry.kind !== 'file') {
        return undefined;
      }
      const limit = deps.maxOpenBytes();
      if (entry.size > limit || !opensAsText(fileKindOf(entry.name))) {
        throw new DbError(
          'unsupported',
          msg('"{0}" is too large or not a text file, so it is not compared', entry.name),
        );
      }
      const other = await askDestination(
        deps,
        serverId,
        entry,
        vscode.l10n.t('Compare "{0}" with a file of a server', entry.name),
      );
      if (other === undefined) {
        return undefined;
      }
      if (other.serverId === serverId && other.path === entry.path) {
        throw new DbError('unsupported', msg('Pick another file: this is the one being compared'));
      }
      const found = await deps.hub.run(other.serverId, (session) => session.stat(other.path));
      if (found?.kind !== 'file') {
        throw new DbError('not-found', msg('"{0}" is not a file on that server', other.path));
      }
      if (found.size > limit) {
        throw new DbError(
          'unsupported',
          msg('"{0}" is too large to compare', baseName(other.path)),
        );
      }
      await vscode.commands.executeCommand(
        'vscode.diff',
        vscode.Uri.from(sftpUriParts(serverId, entry.path)),
        vscode.Uri.from(sftpUriParts(other.serverId, other.path)),
        vscode.l10n.t(
          '{0} ({1}) ↔ {2} ({3})',
          entry.name,
          serverOf(serverId).name,
          baseName(other.path),
          serverOf(other.serverId).name,
        ),
      );
      return undefined;
    },

    refresh: (node?: unknown) => {
      deps.tree.refresh(isServerNode(node) ? node : undefined);
    },
  };
  return { handlers, drop, moveEntries };
}

/**
 * Where a copy or move goes: another server (or the same one) and a full path, filled with
 * the current place so it is edited rather than typed.
 */
async function askDestination(
  deps: ServerCommandDeps,
  serverId: string,
  entry: SftpEntry,
  title: string,
): Promise<{ serverId: string; path: string } | undefined> {
  let target = serverId;
  const servers = deps.store.list();
  if (servers.length > 1) {
    const picked = await vscode.window.showQuickPick(
      servers.map((server) => ({
        label: server.name,
        description: server.id === serverId ? vscode.l10n.t('This server') : describeServer(server),
        id: server.id,
      })),
      { title: vscode.l10n.t('{0}: which server?', title) },
    );
    if (picked === undefined) {
      return undefined;
    }
    target = picked.id;
  }
  const suggestion =
    target === serverId ? entry.path : joinRemote(parentPath(entry.path), entry.name);
  const path = await vscode.window.showInputBox({
    title: `${title} (${deps.store.get(target)?.name ?? target})`,
    prompt: vscode.l10n.t('The full path of the new place, including the name'),
    value: suggestion,
    valueSelection: [suggestion.lastIndexOf('/') + 1, suggestion.length],
    validateInput: (value) =>
      value.trim() === '' || !value.startsWith('/')
        ? vscode.l10n.t('Give an absolute path, starting with "/"')
        : undefined,
  });
  return path === undefined ? undefined : { serverId: target, path: path.trim() };
}
