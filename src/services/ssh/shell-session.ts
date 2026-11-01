// A remote shell and one-shot commands for the SSH terminal (V13.18): the same chain of SSH
// hops a tunnel uses, then a shell with a pseudo-terminal (or one command) on the last
// server. Only this file, sftp-session.ts, sftp.ts and tunnel.ts import ssh2 (§7).

import { DbError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { msg } from '../../core/user-message';
import type { RemoteFileSpec } from '../remote-snapshots';
import type { ExecControl, ExecResult, ShellExit, ShellSession, ShellWindow } from '../shell-types';
import { connectChain } from './tunnel';
import type { Client, ClientChannel } from 'ssh2';

/** What the server is told about the terminal: the common, widely known name. */
export const TERM = 'xterm-256color';

function closeChain(clients: readonly Client[]): void {
  for (const client of [...clients].reverse()) {
    client.end();
  }
}

function lastOf(clients: readonly Client[]): Client {
  const last = clients.at(-1);
  if (last === undefined) {
    throw new DbError('internal', msg('The SSH chain is empty'));
  }
  return last;
}

class Shell implements ShellSession {
  readonly closed: Promise<ShellExit>;
  private readonly listeners = new Set<(chunk: Buffer) => void>();
  /** Output that arrived before anyone listened (a few bytes of the greeting at most). */
  private early: Buffer[] | undefined = [];
  private ending = false;

  constructor(
    private readonly channel: ClientChannel,
    private readonly clients: readonly Client[],
  ) {
    this.closed = new Promise<ShellExit>((resolve) => {
      let code: number | undefined;
      let signal: string | undefined;
      let settled = false;
      const finish = (reason: ShellExit['reason']): void => {
        if (settled) {
          return;
        }
        settled = true;
        // The channel is over; the links under it are of no use to anyone else.
        closeChain(clients);
        resolve({
          reason: this.ending ? 'closed' : reason,
          ...(code === undefined ? {} : { code }),
          ...(signal === undefined ? {} : { signal }),
        });
      };
      channel.on('exit', (exitCode: number | null, exitSignal?: string) => {
        code = exitCode ?? undefined;
        signal = exitSignal;
      });
      // An error after the login (a dropped link) must be heard, or ssh2 throws it from inside
      // its socket handler and the 'close' events never come.
      channel.on('error', () => {
        finish('dropped');
      });
      channel.once('close', () => {
        // A shell that ended by itself leaves an exit status; a cut link leaves none.
        finish(code !== undefined || signal !== undefined ? 'exit' : 'dropped');
      });
      for (const client of clients) {
        client.on('error', () => {
          finish('dropped');
        });
      }
      lastOf(clients).once('close', () => {
        finish('dropped');
      });
    });
    channel.on('data', (chunk: Buffer) => {
      if (this.early !== undefined) {
        this.early.push(chunk);
        return;
      }
      for (const listener of [...this.listeners]) {
        listener(chunk);
      }
    });
  }

  onData(listener: (chunk: Buffer) => void): void {
    this.listeners.add(listener);
    const early = this.early;
    this.early = undefined;
    for (const chunk of early ?? []) {
      listener(chunk);
    }
  }

  write(data: string | Buffer): void {
    if (!this.ending && this.channel.writable) {
      this.channel.write(data);
    }
  }

  resize(window: ShellWindow): void {
    if (!this.ending && this.channel.writable) {
      this.channel.setWindow(window.rows, window.cols, 0, 0);
    }
  }

  pause(): void {
    this.channel.pause();
  }

  resume(): void {
    this.channel.resume();
  }

  close(): void {
    if (this.ending) {
      return;
    }
    this.ending = true;
    try {
      this.channel.close();
    } catch {
      // Already gone.
    }
    closeChain(this.clients);
  }
}

function shellError(error: unknown): DbError {
  return new DbError(
    'connection-failed',
    msg('The SSH server did not open a shell: {0}', errorMessage(error)),
    { cause: error },
  );
}

export async function openShellSession(
  spec: RemoteFileSpec,
  window: ShellWindow,
  logger: Logger,
): Promise<ShellSession> {
  const clients = await connectChain(spec, logger);
  try {
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      lastOf(clients).shell(
        { term: TERM, cols: window.cols, rows: window.rows, height: 0, width: 0 },
        (error, opened) => {
          if (error) {
            reject(shellError(error));
          } else {
            resolve(opened);
          }
        },
      );
    });
    return new Shell(channel, clients);
  } catch (error) {
    closeChain(clients);
    throw error;
  }
}

/** Runs one command without a terminal and reports how it ended. */
export async function execRemoteCommand(
  spec: RemoteFileSpec,
  command: string,
  control: ExecControl,
  logger: Logger,
): Promise<ExecResult> {
  const clients = await connectChain(spec, logger);
  try {
    const channel = await new Promise<ClientChannel>((resolve, reject) => {
      lastOf(clients).exec(command, (error, opened) => {
        if (error) {
          reject(
            new DbError(
              'connection-failed',
              msg('The SSH server did not run the command: {0}', errorMessage(error)),
              { cause: error },
            ),
          );
        } else {
          resolve(opened);
        }
      });
    });
    return await new Promise<ExecResult>((resolve, reject) => {
      let code: number | undefined;
      let signal: string | undefined;
      let aborted = false;
      const abort = (): void => {
        aborted = true;
        try {
          channel.close();
        } catch {
          // Already gone.
        }
      };
      if (control.signal?.aborted === true) {
        abort();
      }
      control.signal?.addEventListener('abort', abort, { once: true });
      channel.on('data', (chunk: Buffer) => {
        control.onData(chunk, false);
      });
      channel.stderr.on('data', (chunk: Buffer) => {
        control.onData(chunk, true);
      });
      let closed = false;
      let settled = false;
      const settle = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (aborted) {
          resolve({});
        } else if (code === undefined && signal === undefined) {
          // No exit status: the link failed before the command reported one.
          reject(
            new DbError(
              'connection-failed',
              msg('The connection to the server was lost before the command finished'),
            ),
          );
        } else {
          resolve({
            ...(code === undefined ? {} : { code }),
            ...(signal === undefined ? {} : { signal }),
          });
        }
      };
      channel.on('exit', (exitCode: number | null, exitSignal?: string) => {
        code = exitCode ?? undefined;
        signal = exitSignal;
        // The status may be handled after the channel reported closed (seen on Windows and macOS).
        if (closed) {
          settle();
        }
      });
      channel.on('error', (error: Error) => {
        reject(
          new DbError(
            'connection-failed',
            msg('The connection to the server was lost: {0}', errorMessage(error)),
            { cause: error },
          ),
        );
      });
      // The status can arrive in the same packet as the reply to `exec`, before these listeners
      // exist (a command that ends at once); `close` repeats it, as for a child process.
      channel.once('close', (closeCode?: number | null, closeSignal?: string) => {
        control.signal?.removeEventListener('abort', abort);
        closed = true;
        if (code === undefined && signal === undefined) {
          code = typeof closeCode === 'number' ? closeCode : undefined;
          signal = typeof closeSignal === 'string' ? closeSignal : undefined;
        }
        if (aborted || code !== undefined || signal !== undefined) {
          settle();
        } else {
          // Give a status that is still on its way a moment before calling it a lost link.
          setTimeout(settle, 250);
        }
      });
    });
  } finally {
    closeChain(clients);
  }
}
