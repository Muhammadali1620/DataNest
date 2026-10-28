import * as vscode from 'vscode';
import type { ConnectionStore } from '../../services/connection-store';
import { type ConnectionTag, lookOf } from './connection-look';

export function tagText(tag: ConnectionTag): string {
  return tag === 'production' ? vscode.l10n.t('Production') : vscode.l10n.t('Read-only');
}

/** Tree items of connections carry this URI, so decorations can find them. */
export const CONNECTION_URI_SCHEME = 'datanest-connection';

export function connectionUri(connectionId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CONNECTION_URI_SCHEME, path: `/${connectionId}` });
}

/** Colors the label of a connection and adds a dot in its color. */
export class ConnectionDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscription: { dispose(): void };

  constructor(private readonly store: ConnectionStore) {
    this.subscription = store.onDidChange(() => {
      this.changed.fire(undefined);
    });
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CONNECTION_URI_SCHEME) {
      return undefined;
    }
    const look = lookOf(this.store.get(uri.path.slice(1)), tagText);
    if (look === undefined) {
      return undefined;
    }
    const decoration = new vscode.FileDecoration(look.badge, look.tooltip);
    if (look.color !== undefined) {
      decoration.color = new vscode.ThemeColor(look.color);
    }
    // Children of a connection must not inherit its label color.
    decoration.propagate = false;
    return decoration;
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }
}
