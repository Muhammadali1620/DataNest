// The Tools page (V11.10): one panel for the window, small local utilities. Only the parts
// that need the host (hashes, network probes, saving a file, the clipboard) come here.

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { toolsProtocol, type ToolsAction, type ToolsProtocol } from '../../shared/protocols/tools';
import { RpcPeer } from '../../shared/rpc';
import type { ConfigProperty } from '../../shared/tools/settings-map';
import { COMMAND_IDS } from '../command-ids';
import { ImageTools, type SecretsLike } from './tools-image-model';
import { type SettingsAccess, ToolsModel } from './tools-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

/** What the settings tab's buttons need from the rest of the extension. */
export interface ToolsActions {
  readonly closeConnections: () => Promise<void>;
  readonly clearCache: () => void;
  /** Where the TinyPNG key of the image tools is kept (SecretStorage). */
  readonly secrets?: SecretsLike;
}

/** The settings the extension declares in package.json, flattened into one map. */
function declaredSettings(extensionUri: vscode.Uri): Record<string, ConfigProperty> {
  const own = vscode.extensions.all.find(
    (candidate) => candidate.extensionUri.toString() === extensionUri.toString(),
  );
  const contributes = (
    own?.packageJSON as { contributes?: { configuration?: unknown } } | undefined
  )?.contributes;
  const blocks = Array.isArray(contributes?.configuration)
    ? (contributes.configuration as unknown[])
    : [contributes?.configuration];
  const properties: Record<string, ConfigProperty> = {};
  for (const block of blocks) {
    const found = (block as { properties?: Record<string, ConfigProperty> } | undefined)
      ?.properties;
    Object.assign(properties, found);
  }
  return properties;
}

export class ToolsPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.tools';

  private static current: ToolsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<ToolsProtocol['host'], ToolsProtocol['webview']>;
  private disposed = false;

  /** Opens the page, or brings the open one forward. */
  static show(extensionUri: vscode.Uri, logger: Logger, actions?: ToolsActions): ToolsPanel {
    if (ToolsPanel.current !== undefined && !ToolsPanel.current.disposed) {
      ToolsPanel.current.panel.reveal();
      return ToolsPanel.current;
    }
    ToolsPanel.current = new ToolsPanel(extensionUri, logger, actions);
    return ToolsPanel.current;
  }

  static disposeAll(): void {
    ToolsPanel.current?.dispose();
    ToolsPanel.current = undefined;
  }

  private constructor(extensionUri: vscode.Uri, logger: Logger, toolActions?: ToolsActions) {
    const log = logger.child('tools');
    this.panel = createWebviewAppPanel(extensionUri, {
      viewType: ToolsPanel.viewType,
      title: vscode.l10n.t('Tools'),
      app: 'tools',
    });
    this.rpc = new RpcPeer({
      local: toolsProtocol.host,
      remote: toolsProtocol.webview,
      transport: webviewTransport(this.panel.webview, log),
      onProtocolError: (problem) => {
        log.warn(problem);
      },
    });
    const settings: SettingsAccess = {
      properties: () => declaredSettings(extensionUri),
      read: (id) => vscode.workspace.getConfiguration().get(id),
      write: async (id, value) => {
        await vscode.workspace
          .getConfiguration()
          .update(id, value, vscode.ConfigurationTarget.Global);
      },
    };
    const actions: Partial<Record<ToolsAction, () => Promise<void> | void>> = {
      exportConnections: async () => {
        await vscode.commands.executeCommand(COMMAND_IDS.exportConnections);
      },
      importConnections: async () => {
        await vscode.commands.executeCommand(COMMAND_IDS.importConnections);
      },
      reportIssue: async () => {
        await vscode.commands.executeCommand(COMMAND_IDS.reportIssue);
      },
      ...(toolActions === undefined
        ? {}
        : { closeConnections: toolActions.closeConnections, clearCache: toolActions.clearCache }),
    };
    const model = new ToolsModel({
      settings,
      actions,
      pingLine: (line) => {
        this.rpc.emit('pingLine', line);
      },
      confirmKill: async (pid, name, force) => {
        const confirm = force ? vscode.l10n.t('Force quit') : vscode.l10n.t('End process');
        const answer = await vscode.window.showWarningMessage(
          force
            ? vscode.l10n.t('Force quit "{0}" (PID {1})?', name, pid)
            : vscode.l10n.t('End "{0}" (PID {1})?', name, pid),
          {
            modal: true,
            detail: vscode.l10n.t(
              'The program is asked to stop. Unsaved work in it may be lost. This is a process of the whole machine, not only of the editor.',
            ),
          },
          confirm,
        );
        return answer === confirm;
      },
      save: async (name, extension, bytes) => {
        const target = await vscode.window.showSaveDialog({
          title: vscode.l10n.t('Save File'),
          defaultUri: vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()),
            name,
          ),
          filters: { [extension.toUpperCase()]: [extension] },
        });
        if (target === undefined) {
          return 'cancelled';
        }
        try {
          await vscode.workspace.fs.writeFile(target, bytes);
          return 'saved';
        } catch (error) {
          log.warn('Could not save a file from the Tools page', error);
          return 'failed';
        }
      },
    });
    this.rpc.handle('hash', (params) => model.hash(params));
    this.rpc.handle('clipboardText', async () => ({
      text: (await vscode.env.clipboard.readText()).slice(0, 20_000_000),
    }));
    this.rpc.handle('interfaces', () => model.interfaces());
    this.rpc.handle('portCheck', async (params) => await model.portCheck(params));
    this.rpc.handle('dnsLookup', async (params) => await model.dnsLookup(params));
    this.rpc.handle('tcpPing', async (params) => await model.tcpPing(params));
    this.rpc.handle('saveFile', async (params) => await model.saveFile(params));
    this.rpc.handle('publicIp', async () => await model.publicIp());
    this.rpc.handle('dohLookup', async (params) => await model.dohLookup(params));
    this.rpc.handle('icmpPing', async (params) => await model.icmpPing(params));
    this.rpc.handle('icmpCancel', (params) => {
      model.icmpCancel(params);
      return {};
    });
    this.rpc.handle('processes', async () => await model.processes());
    this.rpc.handle('killProcess', async (params) => await model.killProcess(params));
    this.rpc.handle('settingsList', () => model.settingsList());
    this.rpc.handle('settingsSet', async (params) => await model.settingsSet(params));
    this.rpc.handle('settingsReset', async (params) => await model.settingsReset(params));
    this.rpc.handle('runAction', async (params) => await model.runAction(params));
    const images = new ImageTools({
      secrets: toolActions?.secrets,
      openLink: async (url) => {
        const open = vscode.l10n.t('Open link');
        const answer = await vscode.window.showWarningMessage(
          vscode.l10n.t('Open this link from the QR code?'),
          { modal: true, detail: url.toString() },
          open,
        );
        return answer === open && (await vscode.env.openExternal(vscode.Uri.parse(url.toString())));
      },
    });
    this.rpc.handle('tinyStatus', async () => await images.tinyStatus());
    this.rpc.handle('tinySaveKey', async (params) => await images.tinySaveKey(params));
    this.rpc.handle('tinyForgetKey', async () => await images.tinyForgetKey());
    this.rpc.handle('tinyCompress', async (params) => await images.tinyCompress(params));
    this.rpc.handle('openLink', async (params) => await images.openLink(params));
    // A setting changed in the editor's own settings page shows here at once.
    const settingsWatch = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!this.disposed && event.affectsConfiguration('datanest')) {
        this.rpc.emit('settingsChanged', model.settingsList());
      }
    });
    this.panel.onDidDispose(() => {
      settingsWatch.dispose();
      model.dispose();
    });
    this.rpc.on('copyText', ({ text }) => {
      void vscode.env.clipboard.writeText(text);
    });
    this.panel.onDidDispose(() => {
      this.dispose();
    });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.rpc.dispose();
    this.panel.dispose();
  }
}
