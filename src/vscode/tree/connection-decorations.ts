import * as vscode from 'vscode';
import type { ConnectionStore } from '../../services/connection-store';
import { type ConnectionTag, lookOf } from './connection-look';
import type { FavoritesStore } from './favorites';
import { type TreeNode, nodeId } from './nodes';

export function tagText(tag: ConnectionTag): string {
  switch (tag) {
    case 'disabled':
      return vscode.l10n.t('Disabled');
    case 'production':
      return vscode.l10n.t('Production');
    case 'read-only':
      return vscode.l10n.t('Read-only');
  }
}

/** Tree items of connections carry this URI, so decorations can find them. */
export const CONNECTION_URI_SCHEME = 'datanest-connection';

export function connectionUri(connectionId: string): vscode.Uri {
  return vscode.Uri.from({ scheme: CONNECTION_URI_SCHEME, path: `/${connectionId}` });
}

/** Starred nodes other than connections carry this URI, for the yellow star. */
export const STAR_URI_SCHEME = 'datanest-star';

export function starUri(node: TreeNode): vscode.Uri {
  return vscode.Uri.from({
    scheme: STAR_URI_SCHEME,
    path: `/${encodeURIComponent(nodeId(node))}`,
  });
}

/** The theme color of the star. */
const STAR_COLOR = 'charts.yellow';

/** Colors the label of a connection and adds a dot in its color. */
export class ConnectionDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeFileDecorations = this.changed.event;
  private readonly subscription: { dispose(): void };

  constructor(
    private readonly store: ConnectionStore,
    private readonly favorites?: FavoritesStore,
  ) {
    const subscriptions = [
      store.onDidChange(() => {
        this.changed.fire(undefined);
      }),
      ...(favorites === undefined
        ? []
        : [
            favorites.onDidChange(() => {
              this.changed.fire(undefined);
            }),
          ]),
    ];
    this.subscription = {
      dispose: () => {
        for (const one of subscriptions) {
          one.dispose();
        }
      },
    };
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme === STAR_URI_SCHEME) {
      return starDecoration();
    }
    if (uri.scheme !== CONNECTION_URI_SCHEME) {
      return undefined;
    }
    const id = uri.path.slice(1);
    const look = lookOf(this.store.get(id), tagText);
    if (look === undefined) {
      // A starred connection with no other mark still shows its star.
      return this.favorites?.has({ kind: 'connection', connectionId: id }) === true
        ? starDecoration()
        : undefined;
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

function starDecoration(): vscode.FileDecoration {
  const decoration = new vscode.FileDecoration('★', vscode.l10n.t('Favorite'));
  decoration.color = new vscode.ThemeColor(STAR_COLOR);
  decoration.propagate = false;
  return decoration;
}
