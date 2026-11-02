import * as vscode from 'vscode';
import {
  DEFAULT_PROXY_PORTS,
  MAX_SSH_JUMPS,
  newHopId,
  type ProxySettings,
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
  /** The password of the proxy, for a new server. */
  readonly proxyPassword?: string;
  /** What to do with the saved proxy password, for an edit. */
  readonly proxyChange?: PasswordChange;
}

const KEEP: PasswordChange = { kind: 'keep' };

/**
 * Asks, one box at a time, what is needed to log in to a server. Escape in any box cancels
 * the whole thing. When editing, every box starts with the saved value and an empty secret
 * keeps the saved one. Algorithm rules of a saved server are kept as they are; jump hosts
 * and a proxy are asked for in the last step.
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
  const route = await askRoute(existing);
  if (route === undefined) {
    return undefined;
  }
  const hopId = existing?.ssh.id ?? newHopId();
  const ssh: SshTunnelConfig = {
    ...(route.jumps.length === 0 ? {} : { jumps: route.jumps }),
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
    ...(route.proxy === undefined ? {} : { proxy: route.proxy }),
    ...(startPath.trim() === '' ? {} : { startPath: startPath.trim() }),
    ...(readOnly ? { readOnly: true } : {}),
    ...(existing?.color === undefined ? {} : { color: existing.color }),
  };
  const secrets: SshSecretValues = {
    ...route.secrets,
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
    ...route.changes,
    [hopId]: {
      password: secretChange(login.password, auth === 'password'),
      passphrase: secretChange(login.passphrase, auth === 'key'),
    },
  };
  return {
    input,
    secrets,
    changes,
    ...(route.proxyPassword === undefined ? {} : { proxyPassword: route.proxyPassword }),
    proxyChange: route.proxyChange,
  };
}

interface Route {
  readonly jumps: readonly SshHop[];
  readonly proxy?: ProxySettings;
  readonly secrets: SshSecretValues;
  readonly changes: SshSecretChanges;
  readonly proxyPassword?: string;
  readonly proxyChange: PasswordChange;
}

type RouteChoice = 'direct' | 'keep' | 'jumps' | 'proxy' | 'both';

/** How the first connection is made: straight, through jump hosts, through a proxy, or both. */
async function askRoute(existing: SshServerConfig | undefined): Promise<Route | undefined> {
  const saved = (existing?.ssh.jumps?.length ?? 0) > 0 || existing?.proxy !== undefined;
  const items: (vscode.QuickPickItem & { choice: RouteChoice })[] = [
    {
      label: '$(plug) ' + vscode.l10n.t('Directly'),
      description: vscode.l10n.t('This machine reaches the server itself'),
      choice: 'direct',
    },
    ...(saved
      ? [
          {
            label: '$(history) ' + vscode.l10n.t('As saved'),
            description: routeSummary(existing),
            choice: 'keep' as const,
          },
        ]
      : []),
    {
      label: '$(arrow-swap) ' + vscode.l10n.t('Through jump hosts'),
      description: vscode.l10n.t('Log in to other SSH servers first'),
      choice: 'jumps',
    },
    {
      label: '$(globe) ' + vscode.l10n.t('Through a proxy'),
      description: vscode.l10n.t('SOCKS5 or HTTP'),
      choice: 'proxy',
    },
    {
      label: '$(link) ' + vscode.l10n.t('Through jump hosts and a proxy'),
      description: vscode.l10n.t('The proxy reaches the first jump host'),
      choice: 'both',
    },
  ];
  const picked = await vscode.window.showQuickPick(
    items.map((item) => ({ ...item, picked: item.choice === (saved ? 'keep' : 'direct') })),
    { title: vscode.l10n.t('How is the server reached?'), ignoreFocusOut: true },
  );
  if (picked === undefined) {
    return undefined;
  }
  if (picked.choice === 'keep') {
    return {
      jumps: existing?.ssh.jumps ?? [],
      ...(existing?.proxy === undefined ? {} : { proxy: existing.proxy }),
      secrets: {},
      changes: {},
      proxyChange: KEEP,
    };
  }
  const jumps: SshHop[] = [];
  let secrets: SshSecretValues = {};
  let changes: SshSecretChanges = {};
  if (picked.choice === 'jumps' || picked.choice === 'both') {
    for (let index = 0; ; index += 1) {
      const hop = await askJump(index, existing?.ssh.jumps?.[index]);
      if (hop === undefined) {
        return undefined;
      }
      jumps.push(hop.hop);
      secrets = { ...secrets, ...hop.secrets };
      changes = { ...changes, ...hop.changes };
      if (index + 1 >= MAX_SSH_JUMPS || !(await askAnotherJump())) {
        break;
      }
    }
  }
  if (picked.choice === 'proxy' || picked.choice === 'both') {
    const proxy = await askProxy(existing?.proxy);
    if (proxy === undefined) {
      return undefined;
    }
    return {
      jumps,
      proxy: proxy.proxy,
      secrets,
      changes,
      ...(proxy.password === undefined || proxy.password === ''
        ? {}
        : { proxyPassword: proxy.password }),
      proxyChange:
        proxy.password === undefined || proxy.password === ''
          ? proxy.proxy.user === undefined
            ? { kind: 'clear' }
            : KEEP
          : { kind: 'set', value: proxy.password },
    };
  }
  return { jumps, secrets, changes, proxyChange: { kind: 'clear' } };
}

function routeSummary(existing: SshServerConfig | undefined): string {
  const jumps = existing?.ssh.jumps?.length ?? 0;
  return [
    jumps === 0 ? undefined : vscode.l10n.t('{0} jump hosts', jumps),
    existing?.proxy === undefined
      ? undefined
      : `${existing.proxy.kind === 'socks5' ? 'SOCKS5' : 'HTTP'} ${existing.proxy.host}`,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
}

async function askAnotherJump(): Promise<boolean> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(add) ' + vscode.l10n.t('Add another jump host'), more: true },
      { label: '$(check) ' + vscode.l10n.t('That is all'), more: false },
    ],
    { title: vscode.l10n.t('Jump hosts'), ignoreFocusOut: true },
  );
  return picked?.more === true;
}

interface Jump {
  readonly hop: SshHop;
  readonly secrets: SshSecretValues;
  readonly changes: SshSecretChanges;
}

/** One jump host: where it is and how to log in to it; the saved one at that place prefills. */
async function askJump(index: number, existing: SshHop | undefined): Promise<Jump | undefined> {
  const where = vscode.l10n.t('Jump host {0}', index + 1);
  const host = await vscode.window.showInputBox({
    title: `${where}: ${vscode.l10n.t('SSH host')}`,
    value: existing?.host ?? '',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' ? vscode.l10n.t('The host cannot be empty') : undefined,
  });
  if (host === undefined) {
    return undefined;
  }
  const port = await vscode.window.showInputBox({
    title: `${where}: ${vscode.l10n.t('SSH port')}`,
    value: String(existing?.port ?? 22),
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
    title: `${where}: ${vscode.l10n.t('User')}`,
    value: existing?.user ?? '',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' ? vscode.l10n.t('The user cannot be empty') : undefined,
  });
  if (user === undefined) {
    return undefined;
  }
  const auth = await pickAuth(existing?.auth);
  if (auth === undefined) {
    return undefined;
  }
  const login = await askLogin(auth, existing);
  if (login === undefined) {
    return undefined;
  }
  const id = existing?.id ?? newHopId();
  return {
    hop: {
      id,
      host: host.trim(),
      port: Number(port),
      user: user.trim(),
      auth,
      ...(login.keyFile === undefined ? {} : { keyFile: login.keyFile }),
      ...(login.agentSocket === undefined ? {} : { agentSocket: login.agentSocket }),
    },
    secrets: {
      [id]: {
        ...(login.password === undefined || login.password === ''
          ? {}
          : { password: login.password }),
        ...(login.passphrase === undefined || login.passphrase === ''
          ? {}
          : { passphrase: login.passphrase }),
      },
    },
    changes: {
      [id]: {
        password: secretChange(login.password, auth === 'password'),
        passphrase: secretChange(login.passphrase, auth === 'key'),
      },
    },
  };
}

/** SOCKS5 or HTTP proxy: kind, address and, if it asks for one, a login. */
async function askProxy(
  existing: ProxySettings | undefined,
): Promise<{ proxy: ProxySettings; password?: string } | undefined> {
  const kind = await vscode.window.showQuickPick(
    (['socks5', 'http'] as const).map((value) => ({
      label: value === 'socks5' ? 'SOCKS5' : 'HTTP CONNECT',
      proxyKind: value,
      picked: existing?.kind === value,
    })),
    { title: vscode.l10n.t('Proxy type'), ignoreFocusOut: true },
  );
  if (kind === undefined) {
    return undefined;
  }
  const host = await vscode.window.showInputBox({
    title: vscode.l10n.t('Proxy host'),
    value: existing?.host ?? '',
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim() === '' ? vscode.l10n.t('The host cannot be empty') : undefined,
  });
  if (host === undefined) {
    return undefined;
  }
  const port = await vscode.window.showInputBox({
    title: vscode.l10n.t('Proxy port'),
    value: String(existing?.port ?? DEFAULT_PROXY_PORTS[kind.proxyKind]),
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
    title: vscode.l10n.t('Proxy user'),
    prompt: vscode.l10n.t('Leave empty if the proxy asks for no login'),
    value: existing?.user ?? '',
    ignoreFocusOut: true,
  });
  if (user === undefined) {
    return undefined;
  }
  const proxy: ProxySettings = {
    kind: kind.proxyKind,
    host: host.trim(),
    port: Number(port),
    ...(user.trim() === '' ? {} : { user: user.trim() }),
  };
  if (proxy.user === undefined) {
    return { proxy };
  }
  const password = await vscode.window.showInputBox({
    title: vscode.l10n.t('Proxy password'),
    prompt:
      existing?.user === undefined
        ? undefined
        : vscode.l10n.t('Leave empty to keep the saved password'),
    password: true,
    ignoreFocusOut: true,
  });
  return password === undefined ? undefined : { proxy, password };
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
