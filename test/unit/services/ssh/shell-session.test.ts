// The shell and one-shot commands of the SSH terminal (V13.18) against an SSH server inside
// the test process: real logins, real pseudo-terminal and window-change requests.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { RemoteFileSpec } from '../../../../src/services/remote-snapshots';
import type { ShellSession } from '../../../../src/services/shell-types';
import { execRemoteCommand, openShellSession } from '../../../../src/services/ssh/shell-session';
import { RecordingLogger } from '../../../helpers/fakes';
import { startSshServer, type TestSshServer } from '../../../helpers/ssh-server';

const TRUST = () => Promise.resolve(true);

function specFor(server: TestSshServer, password = 'pw'): RemoteFileSpec {
  return {
    hops: [{ host: '127.0.0.1', port: server.port, user: 'deploy', auth: 'password', password }],
    checkHostKey: TRUST,
    timeoutMs: 5000,
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

/** Collects what a shell prints. */
function listen(shell: ShellSession): { text(): string; bytes(): number } {
  const chunks: Buffer[] = [];
  shell.onData((chunk) => chunks.push(chunk));
  return {
    text: () => Buffer.concat(chunks).toString('utf8'),
    bytes: () => chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  };
}

const users = [{ name: 'deploy', password: 'pw' }];
let server: TestSshServer | undefined;
const shells: ShellSession[] = [];

async function open(
  options: Parameters<typeof startSshServer>[0],
  window = { cols: 100, rows: 30 },
): Promise<{ server: TestSshServer; shell: ShellSession }> {
  server = await startSshServer(options);
  const shell = await openShellSession(specFor(server), window, new RecordingLogger());
  shells.push(shell);
  return { server, shell };
}

afterEach(async () => {
  for (const shell of shells.splice(0)) {
    shell.close();
  }
  await server?.close();
  server = undefined;
});

describe('openShellSession', () => {
  it('asks for a pseudo-terminal of the size the editor has, with a common terminal name', async () => {
    const opened = await open({
      users,
      shell: (channel) => {
        channel.write('welcome\r\n');
      },
    });
    expect(opened.server.ptys).toEqual([{ term: 'xterm-256color', cols: 100, rows: 30 }]);
    expect(opened.server.shells).toBe(1);
  });

  it('delivers output, including what came before anyone listened', async () => {
    const { shell } = await open({
      users,
      shell: (channel) => {
        channel.write('hello ');
        channel.write('world');
      },
    });
    // Listening only now, a tick after the shell opened.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const output = listen(shell);
    await until(() => output.text() === 'hello world', 'the greeting');
  });

  it('sends typed keys as they are, Ctrl+C and multi-byte characters included', async () => {
    const received: Buffer[] = [];
    const { shell } = await open({
      users,
      shell: (channel) => {
        channel.on('data', (chunk: Buffer) => {
          received.push(chunk);
          channel.write(chunk);
        });
      },
    });
    const output = listen(shell);
    shell.write('ls\r');
    shell.write('\u0003');
    shell.write('щит ✓');
    await until(() => output.text() === 'ls\r\u0003щит ✓', 'the echo');
    expect(Buffer.concat(received).toString('utf8')).toBe('ls\r\u0003щит ✓');
  });

  it('tells the server when the window changes size', async () => {
    const { server: running, shell } = await open({
      users,
      shell: (channel) => {
        channel.write('$ ');
      },
    });
    shell.resize({ cols: 132, rows: 43 });
    shell.resize({ cols: 90, rows: 20 });
    await until(() => running.windowChanges.length === 2, 'the window changes');
    expect(running.windowChanges).toEqual([
      { cols: 132, rows: 43 },
      { cols: 90, rows: 20 },
    ]);
  });

  it('reports an exit status when the shell ends by itself', async () => {
    const { shell } = await open({
      users,
      shell: (channel) => {
        channel.on('data', () => {
          channel.exit(3);
          channel.end();
        });
      },
    });
    shell.write('exit 3\r');
    expect(await shell.closed).toEqual({ reason: 'exit', code: 3 });
  });

  it('says "closed", not "dropped", when we close it', async () => {
    const { shell } = await open({
      users,
      shell: (channel) => {
        channel.write('$ ');
      },
    });
    shell.close();
    shell.close();
    expect((await shell.closed).reason).toBe('closed');
  });

  it('says "dropped" when the link is cut', async () => {
    const { server: running, shell } = await open({
      users,
      shell: (channel) => {
        channel.write('$ ');
      },
    });
    await until(() => running.shells === 1, 'the shell');
    running.kick();
    expect((await shell.closed).reason).toBe('dropped');
  });

  it('ignores writes and resizes after the shell is gone', async () => {
    const { shell } = await open({
      users,
      shell: (channel) => {
        channel.write('$ ');
      },
    });
    shell.close();
    await shell.closed;
    expect(() => {
      shell.write('x');
      shell.resize({ cols: 10, rows: 10 });
    }).not.toThrow();
  });

  it('holds back output while paused and delivers all of it after', async () => {
    const total = 600_000;
    const { shell } = await open({
      users,
      shell: (channel) => {
        channel.write(Buffer.alloc(total, 0x61));
      },
    });
    const output = listen(shell);
    shell.pause();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const whilePaused = output.bytes();
    expect(whilePaused).toBeLessThan(total);
    shell.resume();
    await until(() => output.bytes() === total, 'all the output');
  });

  it('fails clearly when the server offers no shell', async () => {
    server = await startSshServer({ users });
    const error = await openShellSession(
      specFor(server),
      { cols: 80, rows: 24 },
      new RecordingLogger(),
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('connection-failed');
    expect((error as DbError).message).toMatch(/shell/i);
  });

  it('fails with a login error for a wrong password', async () => {
    server = await startSshServer({ users, shell: () => undefined });
    const error = await openShellSession(
      specFor(server, 'nope'),
      { cols: 80, rows: 24 },
      new RecordingLogger(),
    ).catch((caught: unknown) => caught);
    expect((error as DbError).code).toBe('auth-failed');
  });
});

describe('execRemoteCommand', () => {
  it('runs a command and returns its output and status', async () => {
    server = await startSshServer({
      users,
      exec: (command, channel) => {
        channel.write(`ran: ${command}\n`);
        channel.stderr.write('warning\n');
        channel.exit(0);
        channel.end();
      },
    });
    const out: string[] = [];
    const err: string[] = [];
    const result = await execRemoteCommand(
      specFor(server),
      'uptime',
      {
        onData: (chunk, error) => {
          (error ? err : out).push(chunk.toString('utf8'));
        },
      },
      new RecordingLogger(),
    );
    expect(result).toEqual({ code: 0 });
    expect(out.join('')).toBe('ran: uptime\n');
    expect(err.join('')).toBe('warning\n');
    expect(server.execs).toEqual(['uptime']);
  });

  it('reports a failing status', async () => {
    server = await startSshServer({
      users,
      exec: (_command, channel) => {
        channel.exit(2);
        channel.end();
      },
    });
    const result = await execRemoteCommand(
      specFor(server),
      'false',
      { onData: () => undefined },
      new RecordingLogger(),
    );
    expect(result).toEqual({ code: 2 });
  });

  it('stops a command that runs on when the signal aborts', async () => {
    server = await startSshServer({
      users,
      exec: (_command, channel) => {
        channel.write('started\n');
        // Never ends by itself.
      },
    });
    const abort = new AbortController();
    const out: string[] = [];
    const pending = execRemoteCommand(
      specFor(server),
      'sleep 1000',
      {
        signal: abort.signal,
        onData: (chunk) => {
          out.push(chunk.toString('utf8'));
          abort.abort();
        },
      },
      new RecordingLogger(),
    );
    expect(await pending).toEqual({});
    expect(out.join('')).toBe('started\n');
  });

  it('asks the command to stop with a TERM signal when the call is aborted', async () => {
    server = await startSshServer({
      users,
      exec: (_command, channel) => {
        channel.write('started\n');
      },
    });
    const abort = new AbortController();
    const pending = execRemoteCommand(
      specFor(server),
      'sleep 1000',
      {
        signal: abort.signal,
        onData: () => {
          abort.abort();
        },
      },
      new RecordingLogger(),
    );
    expect(await pending).toEqual({});
    await vi.waitFor(() => {
      expect(server?.signals).toEqual(['TERM']);
    });
  });

  it('does not even run a command that was aborted before it started', async () => {
    server = await startSshServer({
      users,
      exec: (_command, channel) => {
        channel.write('never ends\n');
      },
    });
    const abort = new AbortController();
    abort.abort();
    const result = await execRemoteCommand(
      specFor(server),
      'sleep 1000',
      { signal: abort.signal, onData: () => undefined },
      new RecordingLogger(),
    );
    expect(result).toEqual({});
  });

  it('fails when the link is lost before the command reports a status', async () => {
    server = await startSshServer({
      users,
      exec: (_command, channel) => {
        channel.write('half');
      },
    });
    const running = server;
    const pending = execRemoteCommand(
      specFor(running),
      'long',
      {
        onData: () => {
          running.kick();
        },
      },
      new RecordingLogger(),
    );
    await expect(pending).rejects.toMatchObject({ code: 'connection-failed' });
  });

  it('fails clearly when the server refuses commands', async () => {
    server = await startSshServer({ users });
    await expect(
      execRemoteCommand(specFor(server), 'ls', { onData: () => undefined }, new RecordingLogger()),
    ).rejects.toMatchObject({ code: 'connection-failed' });
  });
});

describe('a shell and a command on the same server', () => {
  it('each log in once and leave nothing behind', async () => {
    server = await startSshServer({
      users,
      shell: (channel) => {
        channel.write('$ ');
      },
      exec: (_command, channel) => {
        channel.exit(0);
        channel.end();
      },
    });
    shells.push(
      await openShellSession(specFor(server), { cols: 80, rows: 24 }, new RecordingLogger()),
    );
    await execRemoteCommand(
      specFor(server),
      'true',
      { onData: () => undefined },
      new RecordingLogger(),
    );
    expect(server.logins).toEqual(['deploy', 'deploy']);
  });
});
