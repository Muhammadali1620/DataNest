// The SSH terminal of a saved server (V13.18), without the editor: what the terminal does
// when it opens, when keys are typed, when the window is resized, when the link drops. The
// editor layer (vscode/servers/terminal.ts) wraps it in a pseudo-terminal; the SSH side comes
// in as a function that opens a shell, so all of this is unit-tested without a network.

import { StringDecoder } from 'node:string_decoder';
import { type Disposable } from '../core/disposable';
import { DbError, errorMessage } from '../core/errors';
import { msg } from '../core/user-message';
import { cdLine } from '../shared/shell-quote';
import type { RemoteFileSpec } from './remote-snapshots';
import type { ServerStore } from './server-store';
import type { ShellExit, ShellSession, ShellWindow } from './shell-types';
import { type HostKeyCheck, serverFileSpecOf } from './tunnels';

/** Output is handed to the screen at most this often, so a flood does not choke the editor. */
export const FLUSH_MS = 16;
/** The most characters handed to the screen at once. */
export const FLUSH_CHARS = 256 * 1024;
/** When this much output waits for the screen, the server is told to stop sending. */
export const HIGH_WATER = 1024 * 1024;
/** And when it is down to this, to go on. */
export const LOW_WATER = 256 * 1024;
/** Terminals open at the same time on one server. */
export const MAX_TERMINALS_PER_SERVER = 8;

/** The window to start with when the editor has not said its size yet. */
export const DEFAULT_WINDOW: ShellWindow = { cols: 80, rows: 24 };

/** A timer the tests can replace. */
export interface Scheduler {
  after(ms: number, run: () => void): { cancel(): void };
}

export const realScheduler: Scheduler = {
  after: (ms, run) => {
    const timer = setTimeout(run, ms);
    return {
      cancel: () => {
        clearTimeout(timer);
      },
    };
  },
};

export interface TerminalDeps {
  /** Opens a shell on the server (a new login every time). */
  readonly open: (window: ShellWindow) => Promise<ShellSession>;
  /** Writes to the screen of the terminal. */
  readonly write: (text: string) => void;
  /** The folder to start in; the shell is moved there once it is open. */
  readonly cwd?: string;
  /** Called once when the terminal is closed for good, to free its place. */
  readonly onClosed?: () => void;
  readonly scheduler?: Scheduler;
}

type State = 'new' | 'connecting' | 'live' | 'ended' | 'closed';

const CRLF = '\r\n';
const DIM = '\u001b[2m';
const RESET = '\u001b[0m';

/** A line of the terminal's own, set apart from the server's output. */
function notice(text: string): string {
  return `${CRLF}${DIM}[${text}]${RESET}${CRLF}`;
}

export class TerminalController implements Disposable {
  private state: State = 'new';
  private shell: ShellSession | undefined;
  private window: ShellWindow = DEFAULT_WINDOW;
  private readonly scheduler: Scheduler;
  private decoder = new StringDecoder('utf8');
  private pending = '';
  private paused = false;
  private timer: { cancel(): void } | undefined;
  /** Bumped by every connection, so a late event of an old shell is ignored. */
  private generation = 0;

  constructor(private readonly deps: TerminalDeps) {
    this.scheduler = deps.scheduler ?? realScheduler;
  }

  get status(): 'connecting' | 'live' | 'ended' | 'closed' | 'new' {
    return this.state;
  }

  /** The editor opened the terminal; `window` is its size, if it knows it yet. */
  async start(window?: ShellWindow): Promise<void> {
    if (window !== undefined) {
      this.window = window;
    }
    if (this.state === 'new') {
      await this.connect();
    }
  }

  /** Keys typed in the terminal. After the shell ended, any key opens a new one. */
  input(data: string): void {
    if (this.state === 'live') {
      this.shell?.write(data);
    } else if (this.state === 'ended') {
      void this.connect();
    }
    // Connecting or closed: nothing to type into.
  }

  resize(window: ShellWindow): void {
    this.window = window;
    if (this.state === 'live') {
      this.shell?.resize(window);
    }
  }

  /** The editor closed the terminal: the shell ends and the place is freed. */
  close(): void {
    if (this.state === 'closed') {
      return;
    }
    this.state = 'closed';
    this.generation += 1;
    this.timer?.cancel();
    this.timer = undefined;
    this.pending = '';
    this.shell?.close();
    this.shell = undefined;
    this.deps.onClosed?.();
  }

  dispose(): void {
    this.close();
  }

  private async connect(): Promise<void> {
    this.state = 'connecting';
    const generation = (this.generation += 1);
    this.decoder = new StringDecoder('utf8');
    this.deps.write(notice(msg('Connecting…')));
    let shell: ShellSession;
    try {
      shell = await this.deps.open(this.window);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.state = 'ended';
      this.deps.write(
        notice(
          msg(
            'Could not connect: {0}. Press any key to try again, or close the terminal.',
            error instanceof DbError ? error.message : errorMessage(error),
          ),
        ),
      );
      return;
    }
    if (generation !== this.generation) {
      // Closed while the login was going on.
      shell.close();
      return;
    }
    this.shell = shell;
    this.state = 'live';
    shell.onData((chunk) => {
      if (generation === this.generation) {
        this.receive(chunk);
      }
    });
    if (this.deps.cwd !== undefined) {
      shell.write(cdLine(this.deps.cwd));
    }
    void shell.closed.then((exit) => {
      if (generation === this.generation) {
        this.ended(exit);
      }
    });
  }

  private ended(exit: ShellExit): void {
    this.flushAll();
    this.shell = undefined;
    if (exit.reason === 'closed') {
      return;
    }
    this.state = 'ended';
    this.paused = false;
    if (exit.reason === 'dropped') {
      this.deps.write(
        notice(msg('The connection was lost. Press any key to reconnect, or close the terminal.')),
      );
    } else if (exit.code !== undefined && exit.code !== 0) {
      this.deps.write(
        notice(
          msg(
            'The session ended with exit code {0}. Press any key to reconnect, or close the terminal.',
            exit.code,
          ),
        ),
      );
    } else {
      this.deps.write(
        notice(msg('The session ended. Press any key to reconnect, or close the terminal.')),
      );
    }
  }

  /** Output from the server: decoded whole characters, handed on in small batches. */
  private receive(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    if (!this.paused && this.pending.length >= HIGH_WATER) {
      this.paused = true;
      this.shell?.pause();
    }
    this.timer ??= this.scheduler.after(FLUSH_MS, () => {
      this.timer = undefined;
      this.flushSome();
    });
  }

  private flushSome(): void {
    if (this.pending === '') {
      return;
    }
    let end = Math.min(this.pending.length, FLUSH_CHARS);
    // Never cut a character made of two code units in half.
    const last = this.pending.charCodeAt(end - 1);
    if (end < this.pending.length && last >= 0xd800 && last <= 0xdbff) {
      end -= 1;
    }
    const part = this.pending.slice(0, end);
    this.pending = this.pending.slice(end);
    this.deps.write(part);
    if (this.paused && this.pending.length <= LOW_WATER) {
      this.paused = false;
      this.shell?.resume();
    }
    if (this.pending !== '') {
      this.timer = this.scheduler.after(FLUSH_MS, () => {
        this.timer = undefined;
        this.flushSome();
      });
    }
  }

  /** Everything that waits goes out now, e.g. before the closing notice. */
  private flushAll(): void {
    this.timer?.cancel();
    this.timer = undefined;
    const rest = this.pending + this.decoder.end();
    this.pending = '';
    if (rest !== '') {
      this.deps.write(rest);
    }
  }
}

/** Keeps the number of terminals per server within the limit. */
export class TerminalRegistry {
  private readonly open = new Map<string, number>();

  constructor(private readonly limit: number = MAX_TERMINALS_PER_SERVER) {}

  /** Takes a place for a terminal of the server; the returned function gives it back. */
  claim(serverId: string, serverName: string): () => void {
    const count = this.open.get(serverId) ?? 0;
    if (count >= this.limit) {
      throw new DbError(
        'unsupported',
        msg(
          'Too many terminals are open on "{0}" ({1}). Close one to open another.',
          serverName,
          this.limit,
        ),
      );
    }
    this.open.set(serverId, count + 1);
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      const now = (this.open.get(serverId) ?? 1) - 1;
      if (now <= 0) {
        this.open.delete(serverId);
      } else {
        this.open.set(serverId, now);
      }
    };
  }

  count(serverId: string): number {
    return this.open.get(serverId) ?? 0;
  }
}

/** Turns the raw output of a command into text, keeping characters whole across chunks. */
export class OutputDecoder {
  private readonly decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')] as const;

  write(chunk: Buffer, error: boolean): string {
    return this.decoders[error ? 1 : 0].write(chunk);
  }

  end(): string {
    return this.decoders[0].end() + this.decoders[1].end();
  }
}

/** The closing line for a command: how it ended. */
export function describeExecResult(result: { code?: number; signal?: string }): string {
  if (result.signal !== undefined) {
    return msg('The command was stopped by the signal {0}', result.signal);
  }
  if (result.code === undefined) {
    return msg('The command was stopped');
  }
  return result.code === 0
    ? msg('The command finished')
    : msg('The command finished with exit code {0}', result.code);
}

/**
 * How to log in to a saved server: the chain of hops, the proxy and the secrets, resolved
 * now, so a terminal that reconnects later uses what is saved at that moment.
 */
export async function specOfServer(
  store: Pick<ServerStore, 'get' | 'getSshSecrets' | 'getProxyPassword'>,
  serverId: string,
  checkHostKey: HostKeyCheck,
): Promise<RemoteFileSpec> {
  const server = store.get(serverId);
  if (server === undefined) {
    throw new DbError('not-found', msg('The server "{0}" does not exist', serverId));
  }
  return serverFileSpecOf(
    server,
    await store.getSshSecrets(serverId),
    checkHostKey,
    await store.getProxyPassword(serverId),
  );
}
