import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import type { RpcTransport } from '../../shared/rpc';
import {
  createNonce,
  panelIconPaths,
  renderWebviewHtml,
  WEBVIEW_ASSET_DIR,
  webviewAssetPaths,
} from './webview-html';

export interface WebviewAppPanelOptions {
  readonly viewType: string;
  readonly title: string;
  /** Folder name in webview/src/apps. */
  readonly app: string;
  readonly column?: vscode.ViewColumn;
  /** Leaves the keyboard where it is; a results panel must not steal the editor. */
  readonly preserveFocus?: boolean;
}

/**
 * Creates a panel that may load only our webview bundles (ARCHITECTURE.md §8)
 * and fills it with the app's HTML shell.
 */
export function createWebviewAppPanel(
  extensionUri: vscode.Uri,
  options: WebviewAppPanelOptions,
): vscode.WebviewPanel {
  const root = vscode.Uri.joinPath(extensionUri, ...WEBVIEW_ASSET_DIR);
  const panel = vscode.window.createWebviewPanel(
    options.viewType,
    options.title,
    {
      viewColumn: options.column ?? vscode.ViewColumn.Active,
      preserveFocus: options.preserveFocus ?? false,
    },
    { enableScripts: true, localResourceRoots: [root] },
  );
  const icon = panelIconPaths(options.app);
  if (icon !== undefined) {
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, ...icon.light),
      dark: vscode.Uri.joinPath(extensionUri, ...icon.dark),
    };
  }
  const { webview } = panel;
  const assets = webviewAssetPaths(options.app);
  const toUri = (path: readonly string[]): string =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...path)).toString();
  webview.html = renderWebviewHtml({
    cspSource: webview.cspSource,
    scriptUri: toUri(assets.script),
    styleUri: toUri(assets.style),
    nonce: createNonce(),
    title: options.title,
    lang: vscode.env.language,
  });
  return panel;
}

/** RPC transport over a webview; failed posts are logged instead of rejecting unhandled. */
export function webviewTransport(webview: vscode.Webview, logger: Logger): RpcTransport {
  const post = async (message: unknown): Promise<void> => {
    try {
      const delivered = await webview.postMessage(message);
      if (!delivered) {
        logger.debug('A message to the webview was not delivered');
      }
    } catch (error) {
      logger.warn('Could not post a message to the webview', error);
    }
  };
  return {
    post: (message) => {
      void post(message);
    },
    subscribe: (listener) => webview.onDidReceiveMessage(listener),
  };
}
