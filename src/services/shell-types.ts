// What the SSH terminal (V13.18) needs of a remote shell and of a one-shot command. The
// implementation sits in the SSH bundle (services/ssh/shell-session.ts, a file that talks to
// ssh2); the terminal controller, the commands and the tests work against these types.

import type { RemoteFileSpec } from './remote-snapshots';

/** The size of the terminal window, in characters. */
export interface ShellWindow {
  readonly cols: number;
  readonly rows: number;
}

/** How a shell ended. */
export interface ShellExit {
  /** `exit`: the shell finished; `dropped`: the link failed; `closed`: we closed it. */
  readonly reason: 'exit' | 'dropped' | 'closed';
  readonly code?: number;
  readonly signal?: string;
}

export interface ShellSession {
  /** Settles once, when the shell is gone. */
  readonly closed: Promise<ShellExit>;
  /** Listens to the output of the shell (standard output and error are one stream in a pty). */
  onData(listener: (chunk: Buffer) => void): void;
  write(data: string | Buffer): void;
  /** Tells the server the window changed size. */
  resize(window: ShellWindow): void;
  /** Stops reading from the server, so a flood of output waits there instead of here. */
  pause(): void;
  resume(): void;
  /** Ends the shell; safe to call twice. */
  close(): void;
}

export interface ExecResult {
  /** The exit status; undefined when the command was cut short or killed by a signal. */
  readonly code?: number;
  readonly signal?: string;
}

export interface ExecControl {
  /** Receives the output as it arrives. `error` is true for the error stream. */
  readonly onData: (chunk: Buffer, error: boolean) => void;
  /** Aborting ends the command. */
  readonly signal?: AbortSignal;
}

/** How a command with a pipe to it ended. */
export interface ExecEnd {
  /** `exit`: the command finished; `dropped`: the link failed; `closed`: we closed it. */
  readonly reason: 'exit' | 'dropped' | 'closed';
  readonly code?: number;
  readonly signal?: string;
}

/**
 * A command that keeps running with its input and output open (V13.33): the helper that
 * changes a SQLite file on a server talks to it line by line. No terminal, so the two
 * output streams stay apart.
 */
export interface ExecChannel {
  /** Settles once, when the command is gone. */
  readonly closed: Promise<ExecEnd>;
  /** Listens to the output; `error` is true for the error stream. */
  onData(listener: (chunk: Buffer, error: boolean) => void): void;
  write(data: string): void;
  /** Ends the command (its input is closed first); safe to call twice. */
  close(): void;
}

/** What the SSH bundle offers the terminal: a shell and a one-shot command over a chain. */
export interface ShellOpener {
  openShell(spec: RemoteFileSpec, window: ShellWindow): Promise<ShellSession>;
  execCommand(spec: RemoteFileSpec, command: string, control: ExecControl): Promise<ExecResult>;
}

/** What the writer of a remote SQLite file needs: a command that stays open. */
export interface ExecOpener {
  openExec(spec: RemoteFileSpec, command: string): Promise<ExecChannel>;
}
