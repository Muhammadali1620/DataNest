// A small stand-in for the `vscode` module, for the unit tests of the parts of the host that
// talk to the editor (V13.16): the Servers view, the SFTP file system and their commands.
// Use it with `vi.mock('vscode', () => import('../../helpers/vscode-stub'))`. Dialogs are
// `vi.fn()`s the test answers.

import { vi } from 'vitest';

export class Disposable {
  constructor(private readonly callOnDispose: () => void) {}
  dispose(): void {
    this.callOnDispose();
  }
}

export class EventEmitter<T> {
  private listeners = new Set<(value: T) => void>();
  readonly event = (listener: (value: T) => void): Disposable => {
    this.listeners.add(listener);
    return new Disposable(() => this.listeners.delete(listener));
  };
  fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export enum FileType {
  Unknown = 0,
  File = 1,
  Directory = 2,
  SymbolicLink = 64,
}

export enum FileChangeType {
  Changed = 1,
  Created = 2,
  Deleted = 3,
}

export enum FilePermission {
  Readonly = 1,
}

export class FileSystemError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
  static FileNotFound(what?: unknown): FileSystemError {
    return new FileSystemError(String(what), 'FileNotFound');
  }
  static FileExists(what?: unknown): FileSystemError {
    return new FileSystemError(String(what), 'FileExists');
  }
  static NoPermissions(what?: unknown): FileSystemError {
    return new FileSystemError(String(what), 'NoPermissions');
  }
  static Unavailable(what?: unknown): FileSystemError {
    return new FileSystemError(String(what), 'Unavailable');
  }
}

function format(message: string, args: readonly unknown[]): string {
  return message.replace(/\{(\d+)\}/gu, (place, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? place : typeof value === 'string' ? value : JSON.stringify(value);
  });
}

export const l10n = {
  t: (message: string, ...args: unknown[]): string => format(message, args),
};

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  id?: string;
  description?: string;
  contextValue?: string;
  iconPath?: unknown;
  tooltip?: unknown;
  command?: { command: string; title: string; arguments?: unknown[] };
  constructor(
    readonly label: string,
    readonly collapsibleState: TreeItemCollapsibleState,
  ) {}
}

export class ThemeIcon {
  constructor(
    readonly id: string,
    readonly color?: ThemeColor,
  ) {}
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export class MarkdownString {
  constructor(readonly value = '') {}
}

export interface StubUri {
  scheme: string;
  authority: string;
  path: string;
  fsPath: string;
  toString(): string;
}

function makeUri(scheme: string, authority: string, path: string): StubUri {
  return {
    scheme,
    authority,
    path,
    fsPath: path,
    toString: () => `${scheme}://${authority}${path}`,
  };
}

export const Uri = {
  from: (parts: { scheme: string; authority?: string; path?: string }): StubUri =>
    makeUri(parts.scheme, parts.authority ?? '', parts.path ?? ''),
  file: (path: string): StubUri => makeUri('file', '', path),
  parse: (text: string): StubUri => {
    const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/iu.exec(text);
    if (match === null) {
      throw new Error(`Cannot parse ${text}`);
    }
    return makeUri(match[1] ?? '', match[2] ?? '', decodeURIComponent(match[3] ?? ''));
  },
};

export const ProgressLocation = { Notification: 15 };

export const window = {
  showInputBox: vi.fn(),
  showQuickPick: vi.fn(),
  showWarningMessage: vi.fn(),
  showInformationMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  showOpenDialog: vi.fn(),
  showSaveDialog: vi.fn(),
  createTerminal: vi.fn(),
  createOutputChannel: vi.fn(),
  withProgress: vi.fn(
    (
      _options: unknown,
      task: (
        progress: { report(value: unknown): void },
        token: { onCancellationRequested(listener: () => void): void },
      ) => Promise<unknown>,
    ) => task({ report: vi.fn() }, { onCancellationRequested: vi.fn() }),
  ),
};

export const commands = { executeCommand: vi.fn() };

export const env = {
  language: 'en',
  clipboard: { writeText: vi.fn(), readText: vi.fn() },
};

/** Puts every dialog back to "no answer" between tests. */
export function resetWindow(): void {
  for (const fn of [
    window.showInputBox,
    window.showQuickPick,
    window.showWarningMessage,
    window.showInformationMessage,
    window.showErrorMessage,
    window.showOpenDialog,
    window.showSaveDialog,
    commands.executeCommand,
    env.clipboard.writeText,
  ]) {
    fn.mockReset();
  }
}
