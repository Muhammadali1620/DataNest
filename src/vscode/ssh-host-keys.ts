import * as vscode from 'vscode';
import type { KnownHosts } from '../services/known-hosts';
import type { HostKeyCheck } from '../services/tunnels';

/**
 * Asks the user about SSH server keys it has not seen: trust on first use, and a
 * loud warning when a trusted key changes. Without an answer the key is refused.
 */
export function createHostKeyCheck(known: KnownHosts): HostKeyCheck {
  return async (key) => {
    const status = known.status(key);
    if (status === 'trusted') {
      return true;
    }
    const server = `${key.host}:${key.port}`;
    if (status === 'unknown') {
      const trust = vscode.l10n.t('Trust and Connect');
      const choice = await vscode.window.showWarningMessage(
        vscode.l10n.t('DataNest has not connected to the SSH server {0} before.', server),
        {
          modal: true,
          detail: vscode.l10n.t(
            'Make sure this is the right key of the server before trusting it:\n{0} {1}',
            key.algorithm,
            key.fingerprint,
          ),
        },
        trust,
      );
      if (choice !== trust) {
        return false;
      }
      await known.trust(key);
      return true;
    }
    const replace = vscode.l10n.t('Trust the New Key');
    const choice = await vscode.window.showErrorMessage(
      vscode.l10n.t('The key of the SSH server {0} has changed!', server),
      {
        modal: true,
        detail: vscode.l10n.t(
          'Someone may be intercepting the connection, or the server was reinstalled. Connect only if you know why the key changed.\nTrusted: {0}\nReceived: {1}',
          known.previous(key) ?? '?',
          `${key.algorithm} ${key.fingerprint}`,
        ),
      },
      replace,
    );
    if (choice !== replace) {
      return false;
    }
    await known.trust(key);
    return true;
  };
}
