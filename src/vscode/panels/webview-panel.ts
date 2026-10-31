import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import type { RpcTransport } from '../../shared/rpc';
import { guardPanel, takeOffer } from './panel-handoff';
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
  // A page reached from the bar of another page of a table takes that page's tab (D117):
  // same tab, same place, its content replaced.
  const offer = takeOffer(options.app);
  const handed = offer?.panel;
  const panel =
    handed ??
    vscode.window.createWebviewPanel(
      options.viewType,
      options.title,
      {
        viewColumn: options.column ?? vscode.ViewColumn.Active,
        preserveFocus: options.preserveFocus ?? false,
      },
      { enableScripts: true, localResourceRoots: [root] },
    );
  if (handed !== undefined) {
    panel.title = options.title;
  }
  const icon = panelIconPaths(options.app);
  if (icon !== undefined) {
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, ...icon.light),
      dark: vscode.Uri.joinPath(extensionUri, ...icon.dark),
    };
  } else if (handed !== undefined) {
    panel.iconPath = undefined;
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
    ...(offer?.bar === undefined ? {} : { bar: offer.bar }),
  });
  return guardPanel(panel);
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
