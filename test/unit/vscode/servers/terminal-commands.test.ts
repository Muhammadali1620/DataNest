// The terminal and "Run command" of the Servers view (V13.18): what they ask, what they
// refuse, and what reaches the server — with the editor's dialogs answered by the test and a
// real SSH server with a scripted shell.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordingLogger, FakeMemento, FakeSecretStorage } from '../../../helpers/fakes';
import { ServerStore } from '../../../../src/services/server-store';
import { TerminalRegistry } from '../../../../src/services/ssh-terminal';
import { execRemoteCommand, openShellSession } from '../../../../src/services/ssh/shell-session';
import type { ServerNode } from '../../../../src/vscode/servers/servers-tree';
import {
  type ServerPty,
  type TerminalCommandName,
  terminalCommandHandlers,
} from '../../../../src/vscode/servers/terminal-commands';
import { startSshServer, type TestSshServer } from '../../../helpers/ssh-server';
import * as stub from '../../../helpers/vscode-stub';

vi.mock('vscode', () => import('../../../helpers/vscode-stub'));

const window = stub.window;
const logger = new RecordingLogger();

interface Created {
  readonly options: {
    name: string;
    pty: ServerPty;
    iconPath: stub.ThemeIcon;
    color?: stub.ThemeColor;
  };
  readonly terminal: { show: ReturnType<typeof vi.fn> };
}

let server: TestSshServer;
let store: ServerStore;
let serverId: string;
let readOnlyId: string;
let registry: TerminalRegistry;
let handlers: Record<TerminalCommandName, (...args: unknown[]) => unknown>;
let typed: string[];
let created: Created[];
let channel: {
  show: ReturnType<typeof vi.fn>;
  append: ReturnType<typeof vi.fn>;
  appendLine: ReturnType<typeof vi.fn>;
  lines: string[];
};

function firstCreated(): Created {
  const first = created[0];
  if (first === undefined) {
    throw new Error('No terminal was created');
  }
  return first;
}

const node = (id: string): ServerNode => ({ kind: 'server', serverId: id });

function folderNode(id: string, path: string): ServerNode {
  return {
    kind: 'entry',
    serverId: id,
    entry: {
      name: path.slice(path.lastIndexOf('/') + 1),
      path,
      kind: 'directory',
      link: false,
      size: 0,
      modified: 0,
      mode: 0o40755,
    },
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Opens the terminal the last command created and lets its shell come up. */
async function connect(
  index = created.length - 1,
): Promise<{ screen: () => string; pty: ServerPty }> {
  const pty = created[index]?.options.pty;
  if (pty === undefined) {
    throw new Error('No terminal was created');
  }
  const written: string[] = [];
  pty.onDidWrite((text) => written.push(text));
  pty.open({ columns: 110, rows: 32 });
  await until(() => pty.controller.status === 'live', 'the shell');
  return { screen: () => written.join(''), pty };
}

beforeEach(async () => {
  stub.resetWindow();
  window.createTerminal.mockReset();
  window.createOutputChannel.mockReset();
  typed = [];
  created = [];
  server = await startSshServer({
    users: [{ name: 'deploy', password: 'pw' }],
    shell: (shellChannel) => {
      shellChannel.write('$ ');
      shellChannel.on('data', (chunk: Buffer) => {
        typed.push(chunk.toString('utf8'));
        shellChannel.write(chunk);
      });
    },
    exec: (command, execChannel) => {
      execChannel.write(`out: ${command}\n`);
      if (command.includes('fail')) {
        execChannel.stderr.write('bad\n');
        execChannel.exit(1);
      } else {
        execChannel.exit(0);
      }
      execChannel.end();
    },
  });
  store = new ServerStore({
    state: new FakeMemento(),
    secrets: new FakeSecretStorage(),
    logger,
  });
  const ssh = {
    id: 'main',
    host: '127.0.0.1',
    port: server.port,
    user: 'deploy',
    auth: 'password' as const,
  };
  serverId = (await store.add({ name: 'Web', ssh, color: 'green' }, { main: { password: 'pw' } }))
    .id;
  readOnlyId = (
    await store.add(
      { name: 'Archive', ssh, readOnly: true, startPath: '/archive' },
      { main: { password: 'pw' } },
    )
  ).id;
  registry = new TerminalRegistry(2);
  handlers = terminalCommandHandlers({
    store,
    opener: {
      openShell: (spec, window) => openShellSession(spec, window, logger),
      execCommand: (spec, command, control) => execRemoteCommand(spec, command, control, logger),
    },
    checkHostKey: () => Promise.resolve(true),
    logger,
    registry,
  });
  window.createTerminal.mockImplementation((options: Created['options']) => {
    const terminal = { show: vi.fn() };
    created.push({ options, terminal });
    return terminal;
  });
  const lines: string[] = [];
  channel = {
    show: vi.fn(),
    append: vi.fn((text: string) => lines.push(text)),
    appendLine: vi.fn((text: string) => lines.push(`${text}\n`)),
    lines,
  };
  window.createOutputChannel.mockReturnValue(channel);
});

afterEach(async () => {
  for (const { options } of created) {
    options.pty.close();
  }
  await server.close();
});

describe('Open Terminal', () => {
  it('opens a terminal named and coloured like the server, and shows it', async () => {
    await handlers.openTerminal(node(serverId));
    expect(created).toHaveLength(1);
    const { options, terminal } = firstCreated();
    expect(options.name).toBe('Web');
    expect(options.iconPath.id).toBe('terminal');
    expect(options.iconPath.color?.id).toBe('charts.green');
    expect(options.color?.id).toBe('charts.green');
    expect(terminal.show).toHaveBeenCalled();
  });

  it('uses the neutral colour for a server without one', async () => {
    await store.update(serverId, {
      name: 'Web',
      ssh: store.get(serverId)?.ssh as never,
    });
    await handlers.openTerminal(node(serverId));
    const { options } = firstCreated();
    expect(options.iconPath.color?.id).toBe('foreground');
    expect(options.color).toBeUndefined();
  });

  it('logs in when the editor opens it, with the size of the window', async () => {
    await handlers.openTerminal(node(serverId));
    const { screen } = await connect();
    await until(() => server.ptys.length === 1, 'the pty request');
    expect(server.ptys[0]).toEqual({ term: 'xterm-256color', cols: 110, rows: 32 });
    await until(() => screen().includes('$ '), 'the prompt');
  });

  it('sends typed keys to the shell and shows what it prints', async () => {
    await handlers.openTerminal(node(serverId));
    const { screen, pty } = await connect();
    pty.handleInput('ls\r');
    pty.handleInput('\u0003');
    await until(() => typed.join('') === 'ls\r\u0003', 'the keys');
    await until(() => screen().includes('ls\r\u0003'), 'the echo');
  });

  it('passes a resize on to the server', async () => {
    await handlers.openTerminal(node(serverId));
    const { pty } = await connect();
    pty.setDimensions({ columns: 200, rows: 50 });
    await until(() => server.windowChanges.length === 1, 'the window change');
    expect(server.windowChanges[0]).toEqual({ cols: 200, rows: 50 });
  });

  it('starts in the folder it was opened on, safely quoted', async () => {
    await handlers.openTerminal(folderNode(serverId, "/srv/it's here"));
    expect(created[0]?.options.name).toBe("Web: it's here");
    await connect();
    await until(() => typed.length > 0, 'the cd line');
    expect(typed.join('')).toBe("cd -- '/srv/it'\\''s here'\n");
  });

  it('closing the terminal ends the shell and gives its place back', async () => {
    await handlers.openTerminal(node(serverId));
    const { pty } = await connect();
    expect(registry.count(serverId)).toBe(1);
    pty.close();
    expect(registry.count(serverId)).toBe(0);
    await until(() => server.shells === 1, 'the shell');
  });

  it('refuses to open more terminals on a server than the limit', async () => {
    await handlers.openTerminal(node(serverId));
    await handlers.openTerminal(node(serverId));
    await expect(handlers.openTerminal(node(serverId))).rejects.toThrow(/Too many terminals/u);
    expect(created).toHaveLength(2);
    created[0]?.options.pty.close();
    await handlers.openTerminal(node(serverId));
    expect(created).toHaveLength(3);
  });

  it('gives the place back when the editor cannot create the terminal', async () => {
    window.createTerminal.mockImplementationOnce(() => {
      throw new Error('no terminals here');
    });
    await expect(handlers.openTerminal(node(serverId))).rejects.toThrow('no terminals here');
    expect(registry.count(serverId)).toBe(0);
  });

  it('asks which server when run from the palette', async () => {
    window.showQuickPick.mockResolvedValueOnce({ id: serverId });
    await handlers.openTerminal();
    expect(window.showQuickPick).toHaveBeenCalled();
    expect(created[0]?.options.name).toBe('Web');
  });

  it('does nothing when the palette pick is dismissed', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await handlers.openTerminal();
    expect(created).toHaveLength(0);
  });

  it('says so when there are no servers', async () => {
    await store.remove(serverId);
    await store.remove(readOnlyId);
    await handlers.openTerminal();
    expect(window.showInformationMessage).toHaveBeenCalledWith('There are no saved servers yet');
    expect(created).toHaveLength(0);
  });

  it('refuses a server that was removed meanwhile', async () => {
    await expect(handlers.openTerminal(node('gone'))).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('a read-only server', () => {
  it('is not opened for a terminal unless the user says it may be', async () => {
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await handlers.openTerminal(node(readOnlyId));
    expect(created).toHaveLength(0);
    expect(window.showWarningMessage.mock.calls[0]?.[0]).toBe(
      '"Archive" is marked read-only, but a shell can change anything on it.',
    );
    expect(window.showWarningMessage.mock.calls[0]?.[1]).toMatchObject({ modal: true });
  });

  it('opens once the user continues, in its start folder', async () => {
    window.showWarningMessage.mockResolvedValueOnce('Continue');
    await handlers.openTerminal(node(readOnlyId));
    expect(created).toHaveLength(1);
    await connect();
    await until(() => typed.length > 0, 'the cd line');
    expect(typed.join('')).toBe("cd -- '/archive'\n");
  });

  it('is not asked about for a server that is not read-only', async () => {
    await handlers.openTerminal(node(serverId));
    expect(window.showWarningMessage).not.toHaveBeenCalled();
  });
});

describe('Run Command on Server', () => {
  it('runs the command, shows the output and how it ended', async () => {
    window.showInputBox.mockResolvedValueOnce('uptime');
    await handlers.runCommand(node(serverId));
    expect(server.execs).toEqual(['uptime']);
    expect(window.createOutputChannel).toHaveBeenCalledWith('DataNest: Web');
    expect(channel.show).toHaveBeenCalled();
    expect(channel.lines.join('')).toBe('$ uptime\nout: uptime\n\n[The command finished]\n');
  });

  it('runs inside the folder it was started on', async () => {
    window.showInputBox.mockResolvedValueOnce('ls -la');
    await handlers.runCommand(folderNode(serverId, "/srv/it's"));
    expect(server.execs).toEqual(["cd -- '/srv/it'\\''s' && {\nls -la\n}"]);
  });

  it('shows the error stream and a failing status', async () => {
    window.showInputBox.mockResolvedValueOnce('fail now');
    await handlers.runCommand(node(serverId));
    expect(channel.lines.join('')).toContain('bad\n');
    expect(channel.lines.join('')).toContain('[The command finished with exit code 1]');
  });

  it('offers the last command of the server again', async () => {
    window.showInputBox.mockResolvedValueOnce('uptime');
    await handlers.runCommand(node(serverId));
    window.showInputBox.mockResolvedValueOnce(undefined);
    await handlers.runCommand(node(serverId));
    expect(window.showInputBox.mock.calls[1]?.[0]).toMatchObject({ value: 'uptime' });
    expect(window.showInputBox.mock.calls[0]?.[0]).toMatchObject({ value: '' });
  });

  it('runs nothing for an empty or dismissed input', async () => {
    window.showInputBox.mockResolvedValueOnce('   ');
    await handlers.runCommand(node(serverId));
    window.showInputBox.mockResolvedValueOnce(undefined);
    await handlers.runCommand(node(serverId));
    expect(server.execs).toEqual([]);
  });

  it('asks before running on a read-only server, and runs nothing without a yes', async () => {
    window.showInputBox.mockResolvedValueOnce('rm -rf /tmp/x');
    window.showWarningMessage.mockResolvedValueOnce(undefined);
    await handlers.runCommand(node(readOnlyId));
    expect(server.execs).toEqual([]);
    window.showInputBox.mockResolvedValueOnce('ls');
    window.showWarningMessage.mockResolvedValueOnce('Continue');
    await handlers.runCommand(node(readOnlyId));
    expect(server.execs).toHaveLength(1);
  });

  it('writes the failure into the output and still reports it', async () => {
    await server.close();
    server = await startSshServer({ users: [{ name: 'deploy', password: 'pw' }] });
    const ssh = {
      id: 'other',
      host: '127.0.0.1',
      port: server.port,
      user: 'deploy',
      auth: 'password' as const,
    };
    const otherId = (await store.add({ name: 'NoExec', ssh }, { other: { password: 'pw' } })).id;
    window.showInputBox.mockResolvedValueOnce('ls');
    await expect(handlers.runCommand(node(otherId))).rejects.toMatchObject({
      code: 'connection-failed',
    });
    expect(channel.lines.join('')).toMatch(/\[.*command.*\]/u);
  });

  it('stops the command when the progress notification is cancelled', async () => {
    await server.close();
    server = await startSshServer({
      users: [{ name: 'deploy', password: 'pw' }],
      exec: (_command, execChannel) => {
        execChannel.write('running\n');
      },
    });
    const ssh = {
      id: 'slow',
      host: '127.0.0.1',
      port: server.port,
      user: 'deploy',
      auth: 'password' as const,
    };
    const slowId = (await store.add({ name: 'Slow', ssh }, { slow: { password: 'pw' } })).id;
    window.showInputBox.mockResolvedValueOnce('sleep 1000');
    window.withProgress.mockImplementationOnce(
      (
        _options: unknown,
        task: (
          progress: { report(value: unknown): void },
          token: { onCancellationRequested(listener: () => void): void },
        ) => Promise<unknown>,
      ) => {
        let cancel: () => void = () => undefined;
        const result = task(
          { report: vi.fn() },
          {
            onCancellationRequested: (listener: () => void) => {
              cancel = listener;
            },
          },
        );
        // Cancel once the first output is in.
        void until(() => channel.lines.join('').includes('running'), 'the output').then(() => {
          cancel();
        });
        return result;
      },
    );
    await handlers.runCommand(node(slowId));
    expect(channel.lines.join('')).toContain('[The command was stopped]');
  });

  it('asks which server when run from the palette', async () => {
    window.showQuickPick.mockResolvedValueOnce({ id: serverId });
    window.showInputBox.mockResolvedValueOnce('uptime');
    await handlers.runCommand();
    expect(server.execs).toEqual(['uptime']);
  });

  it('does nothing when the palette pick is dismissed', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined);
    await handlers.runCommand();
    expect(window.showInputBox).not.toHaveBeenCalled();
  });
});
