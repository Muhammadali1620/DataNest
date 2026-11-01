import * as vscode from 'vscode';
import {
  newHopId,
  type SshAuthMethod,
  type SshHop,
  type SshTunnelConfig,
} from '../../shared/connection';
import { isPortValid } from '../../shared/connection';
import type { SshServerConfig, SshServerInput } from '../../shared/ssh-server';
import type {
  PasswordChange,
  SshSecretChanges,
  SshSecretValues,
} from '../../services/connection-store';

/** What the wizard collected. For a new server `secrets` are the values; for an edit, changes. */
export interface ServerAnswers {
  readonly input: SshServerInput;
  readonly secrets: SshSecretValues;
  readonly changes: SshSecretChanges;
}

const KEEP: PasswordChange = { kind: 'keep' };

/**
 * Asks, one box at a time, what is needed to log in to a server. Escape in any box cancels
 * the whole thing. When editing, every box starts with the saved value and an empty secret
 * keeps the saved one. Jump hosts, a proxy and algorithm rules of a saved server are kept
 * as they are.
 */
export async function askServer(existing?: SshServerConfig): Promise<ServerAnswers | undefined> {
  const name = await vscode.window.showInputBox({
    title: vscode.l10n.t('Server name'),
    prompt: vscode.l10n.t('How it is called in the Servers view'),
    value: existing?.name ?? '',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' ? vscode.l10n.t('The name cannot be empty') : undefined,
  });
  if (name === undefined) {
    return undefined;
  }
  const host = await vscode.window.showInputBox({
    title: vscode.l10n.t('SSH host'),
    prompt: vscode.l10n.t('Host name or address of the server'),
    placeHolder: 'server.example.com',
    value: existing?.ssh.host ?? '',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' ? vscode.l10n.t('The host cannot be empty') : undefined,
  });
  if (host === undefined) {
    return undefined;
  }
  const port = await vscode.window.showInputBox({
    title: vscode.l10n.t('SSH port'),
    value: String(existing?.ssh.port ?? 22),
    ignoreFocusOut: true,
    validateInput: (value) =>
      isPortValid(Number(value)) && value.trim() !== ''
        ? undefined
        : vscode.l10n.t('A port is a number from 1 to 65535'),
  });
  if (port === undefined) {
    return undefined;
  }
  const user = await vscode.window.showInputBox({
    title: vscode.l10n.t('User'),
    value: existing?.ssh.user ?? '',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' ? vscode.l10n.t('The user cannot be empty') : undefined,
  });
  if (user === undefined) {
    return undefined;
  }
  const auth = await pickAuth(existing?.ssh.auth);
  if (auth === undefined) {
    return undefined;
  }
  const login = await askLogin(auth, existing?.ssh);
  if (login === undefined) {
    return undefined;
  }
  const startPath = await vscode.window.showInputBox({
    title: vscode.l10n.t('Start folder'),
    prompt: vscode.l10n.t('The folder shown first; leave empty for the login folder'),
    placeHolder: '/var/www',
    value: existing?.startPath ?? '',
    ignoreFocusOut: true,
  });
  if (startPath === undefined) {
    return undefined;
  }
  const readOnly = await pickReadOnly(existing?.readOnly === true);
  if (readOnly === undefined) {
    return undefined;
  }
  const hopId = existing?.ssh.id ?? newHopId();
  const ssh: SshTunnelConfig = {
    ...(existing?.ssh.jumps === undefined ? {} : { jumps: existing.ssh.jumps }),
    ...(existing?.ssh.algorithms === undefined ? {} : { algorithms: existing.ssh.algorithms }),
    id: hopId,
    host: host.trim(),
    port: Number(port),
    user: user.trim(),
    auth,
    ...(login.keyFile === undefined ? {} : { keyFile: login.keyFile }),
    ...(login.agentSocket === undefined ? {} : { agentSocket: login.agentSocket }),
  };
  const input: SshServerInput = {
    name: name.trim(),
    ssh,
    ...(existing?.proxy === undefined ? {} : { proxy: existing.proxy }),
    ...(startPath.trim() === '' ? {} : { startPath: startPath.trim() }),
    ...(readOnly ? { readOnly: true } : {}),
    ...(existing?.color === undefined ? {} : { color: existing.color }),
  };
  const secrets: SshSecretValues = {
    [hopId]: {
      ...(login.password === undefined || login.password === ''
        ? {}
        : { password: login.password }),
      ...(login.passphrase === undefined || login.passphrase === ''
        ? {}
        : { passphrase: login.passphrase }),
    },
  };
  const changes: SshSecretChanges = {
    [hopId]: {
      password: secretChange(login.password, auth === 'password'),
      passphrase: secretChange(login.passphrase, auth === 'key'),
    },
  };
  return { input, secrets, changes };
}

/** An empty answer keeps the saved secret; a method that uses none clears it. */
function secretChange(value: string | undefined, used: boolean): PasswordChange {
  if (!used) {
    return { kind: 'clear' };
  }
  return value === undefined || value === '' ? KEEP : { kind: 'set', value };
}

async function pickAuth(current: SshAuthMethod | undefined): Promise<SshAuthMethod | undefined> {
  const items: (vscode.QuickPickItem & { auth: SshAuthMethod })[] = [
    {
      label: '$(key) ' + vscode.l10n.t('Password'),
      description: vscode.l10n.t("Kept in the editor's secret storage"),
      auth: 'password',
    },
    {
      label: '$(file-binary) ' + vscode.l10n.t('Key file'),
      description: vscode.l10n.t('A private key, with a passphrase if it has one'),
      auth: 'key',
    },
    {
      label: '$(account) ' + vscode.l10n.t('SSH agent'),
      description: vscode.l10n.t('Keys held by ssh-agent or Pageant'),
      auth: 'agent',
    },
  ];
  const picked = await vscode.window.showQuickPick(
    items.map((item) => ({ ...item, picked: item.auth === current })),
    { title: vscode.l10n.t('How to log in'), ignoreFocusOut: true },
  );
  return picked?.auth;
}

interface Login {
  readonly password?: string;
  readonly passphrase?: string;
  readonly keyFile?: string;
  readonly agentSocket?: string;
}

async function askLogin(
  auth: SshAuthMethod,
  existing: SshHop | undefined,
): Promise<Login | undefined> {
  if (auth === 'agent') {
    return existing?.agentSocket === undefined ? {} : { agentSocket: existing.agentSocket };
  }
  if (auth === 'password') {
    const password = await vscode.window.showInputBox({
      title: vscode.l10n.t('Password'),
      prompt:
        existing === undefined
          ? undefined
          : vscode.l10n.t('Leave empty to keep the saved password'),
      password: true,
      ignoreFocusOut: true,
    });
    return password === undefined ? undefined : { password };
  }
  const keyFile = await vscode.window.showInputBox({
    title: vscode.l10n.t('Private key file'),
    prompt: vscode.l10n.t('Path to the key, e.g. ~/.ssh/id_ed25519'),
    value: existing?.keyFile ?? '',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' ? vscode.l10n.t('The key file cannot be empty') : undefined,
  });
  if (keyFile === undefined) {
    return undefined;
  }
  const passphrase = await vscode.window.showInputBox({
    title: vscode.l10n.t('Key passphrase'),
    prompt: vscode.l10n.t('Leave empty if the key has none, or to keep the saved one'),
    password: true,
    ignoreFocusOut: true,
  });
  return passphrase === undefined ? undefined : { keyFile: keyFile.trim(), passphrase };
}

async function pickReadOnly(current: boolean): Promise<boolean | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: '$(edit) ' + vscode.l10n.t('Read and change files'),
        description: vscode.l10n.t('Upload, edit, rename and delete are available'),
        value: false,
      },
      {
        label: '$(lock) ' + vscode.l10n.t('Read only'),
        description: vscode.l10n.t('Browse, open and download; nothing on the server changes'),
        value: true,
      },
    ].map((item) => ({ ...item, picked: item.value === current })),
    { title: vscode.l10n.t('What may be done on this server?'), ignoreFocusOut: true },
  );
  return picked?.value;
}
