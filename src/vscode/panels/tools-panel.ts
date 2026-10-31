// The Tools page (V11.10): one panel for the window, small local utilities. Only the parts
// that need the host (hashes, network probes, saving a file, the clipboard) come here.

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { toolsProtocol, type ToolsProtocol } from '../../shared/protocols/tools';
import { RpcPeer } from '../../shared/rpc';
import { ToolsModel } from './tools-model';
import { createWebviewAppPanel, webviewTransport } from './webview-panel';

export class ToolsPanel implements vscode.Disposable {
  static readonly viewType = 'datanest.tools';

  private static current: ToolsPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly rpc: RpcPeer<ToolsProtocol['host'], ToolsProtocol['webview']>;
  private disposed = false;

  /** Opens the page, or brings the open one forward. */
  static show(extensionUri: vscode.Uri, logger: Logger): ToolsPanel {
    if (ToolsPanel.current !== undefined && !ToolsPanel.current.disposed) {
      ToolsPanel.current.panel.reveal();
      return ToolsPanel.current;
    }
    ToolsPanel.current = new ToolsPanel(extensionUri, logger);
    return ToolsPanel.current;
  }

  static disposeAll(): void {
    ToolsPanel.current?.dispose();
    ToolsPanel.current = undefined;
  }

  private constructor(extensionUri: vscode.Uri, logger: Logger) {
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
    const model = new ToolsModel({
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
    this.rpc.handle('interfaces', () => model.interfaces());
    this.rpc.handle('portCheck', async (params) => await model.portCheck(params));
    this.rpc.handle('dnsLookup', async (params) => await model.dnsLookup(params));
    this.rpc.handle('tcpPing', async (params) => await model.tcpPing(params));
    this.rpc.handle('saveFile', async (params) => await model.saveFile(params));
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
