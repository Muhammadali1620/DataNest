// Runs the helper that changes a SQLite file on a server (V13.33) with a real Python 3 on this
// machine, so the tests meet a real SQLite instead of a script of their own. Two ways in:
// `LocalPythonOpener` hands the writer a child process directly; `runThroughShell` serves an
// `exec` request of the in-process SSH server the same way, with the command line the
// extension really sends.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import type { ServerChannel } from 'ssh2';
import { helperProgram } from '../../src/services/remote-sqlite-script';
import type { RemoteFileSpec } from '../../src/services/remote-snapshots';
import type { ExecChannel, ExecEnd, ExecOpener } from '../../src/services/shell-types';

/** True when `python3` runs here (a Windows runner may only have `python`). */
export const HAS_PYTHON: boolean = (() => {
  try {
    return spawnSync('python3', ['--version'], { timeout: 10_000 }).status === 0;
  } catch {
    return false;
  }
})();

/** A running child process as the channel of an `exec` request. */
export function channelOf(child: ChildProcess): ExecChannel & { readonly pid: number | undefined } {
  const listeners = new Set<(chunk: Buffer, error: boolean) => void>();
  let ending = false;
  const closed = new Promise<ExecEnd>((resolve) => {
    child.once('close', (code, signal) => {
      resolve({
        reason: ending ? 'closed' : 'exit',
        ...(code === null ? {} : { code }),
        ...(signal === null ? {} : { signal }),
      });
    });
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    for (const listener of listeners) {
      listener(chunk, false);
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    for (const listener of listeners) {
      listener(chunk, true);
    }
  });
  child.stdin?.on('error', () => undefined);
  return {
    pid: child.pid,
    closed,
    onData: (listener) => {
      listeners.add(listener);
    },
    write: (data) => {
      child.stdin?.write(data);
    },
    close: () => {
      ending = true;
      child.stdin?.end();
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    },
  };
}

/** Starts the helper directly as a child of the test. */
export class LocalPythonOpener implements ExecOpener {
  readonly commands: string[] = [];
  readonly children: ChildProcess[] = [];

  openExec(_spec: RemoteFileSpec, command: string): Promise<ExecChannel> {
    this.commands.push(command);
    const child = spawn('python3', ['-u', '-c', helperProgram()]);
    this.children.push(child);
    return Promise.resolve(channelOf(child));
  }

  /** Kills whatever is still running. */
  dispose(): void {
    for (const child of this.children) {
      child.kill('SIGKILL');
    }
  }
}

/** Serves an `exec` request of the test SSH server by running the command in `sh`. */
export function runThroughShell(command: string, channel: ServerChannel): ChildProcess {
  // `exec` makes the program take the shell's place, so killing the child kills the program
  // too (otherwise it would outlive the test, orphaned, and spin on a file that is gone).
  const child = spawn('sh', ['-c', `exec ${command}`]);
  // The command may be gone before the client stops writing (a shell that found no python3).
  child.stdin.on('error', () => undefined);
  channel.on('data', (chunk: Buffer) => {
    child.stdin.write(chunk);
  });
  channel.on('end', () => {
    child.stdin.end();
  });
  channel.on('close', () => {
    child.kill('SIGKILL');
  });
  child.stdout.on('data', (chunk: Buffer) => channel.write(chunk));
  child.stderr.on('data', (chunk: Buffer) => channel.stderr.write(chunk));
  child.on('close', (code) => {
    channel.exit(code ?? 1);
    channel.end();
  });
  return child;
}
