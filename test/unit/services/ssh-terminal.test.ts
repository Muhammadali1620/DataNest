// What the SSH terminal does (V13.18), with a scripted shell and a clock of the test's own:
// opening, typing, resizing, batching and backpressure of output, ending, reconnecting.

import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { ShellExit, ShellSession, ShellWindow } from '../../../src/services/shell-types';
import {
  DEFAULT_WINDOW,
  describeExecResult,
  FLUSH_CHARS,
  FLUSH_MS,
  HIGH_WATER,
  OutputDecoder,
  type Scheduler,
  specOfServer,
  TerminalController,
  type TerminalDeps,
  TerminalRegistry,
} from '../../../src/services/ssh-terminal';

class FakeShell implements ShellSession {
  readonly written: (string | Buffer)[] = [];
  readonly windows: ShellWindow[] = [];
  paused = 0;
  resumed = 0;
  closes = 0;
  private listener: ((chunk: Buffer) => void) | undefined;
  private finish!: (exit: ShellExit) => void;
  readonly closed = new Promise<ShellExit>((resolve) => {
    this.finish = resolve;
  });

  onData(listener: (chunk: Buffer) => void): void {
    this.listener = listener;
  }
  write(data: string | Buffer): void {
    this.written.push(data);
  }
  resize(window: ShellWindow): void {
    this.windows.push(window);
  }
  pause(): void {
    this.paused += 1;
  }
  resume(): void {
    this.resumed += 1;
  }
  close(): void {
    this.closes += 1;
    this.finish({ reason: 'closed' });
  }

  // The server side.
  print(data: string | Buffer): void {
    this.listener?.(typeof data === 'string' ? Buffer.from(data) : data);
  }
  end(exit: ShellExit): void {
    this.finish(exit);
  }
}

class Clock implements Scheduler {
  private readonly tasks = new Map<number, () => void>();
  private next = 0;
  after(_ms: number, run: () => void): { cancel(): void } {
    const id = (this.next += 1);
    this.tasks.set(id, run);
    return {
      cancel: () => {
        this.tasks.delete(id);
      },
    };
  }
  get waiting(): number {
    return this.tasks.size;
  }
  tick(): void {
    const due = [...this.tasks.values()];
    this.tasks.clear();
    for (const run of due) {
      run();
    }
  }
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
};

function setup(overrides: Partial<TerminalDeps> = {}) {
  const shells: FakeShell[] = [];
  const screen: string[] = [];
  const clock = new Clock();
  const windows: ShellWindow[] = [];
  const closedCalls = vi.fn();
  let failWith: Error | undefined;
  const controller = new TerminalController({
    open: (window) => {
      windows.push(window);
      if (failWith !== undefined) {
        return Promise.reject(failWith);
      }
      const shell = new FakeShell();
      shells.push(shell);
      return Promise.resolve(shell);
    },
    write: (text) => screen.push(text),
    onClosed: closedCalls,
    scheduler: clock,
    ...overrides,
  });
  return {
    controller,
    shells,
    screen,
    clock,
    windows,
    closedCalls,
    text: () => screen.join(''),
    fail: (error: Error | undefined) => {
      failWith = error;
    },
  };
}

describe('TerminalController: opening', () => {
  it('says it is connecting, then goes live with the window the editor has', async () => {
    const t = setup();
    expect(t.controller.status).toBe('new');
    await t.controller.start({ cols: 120, rows: 40 });
    expect(t.text()).toContain('Connecting…');
    expect(t.windows).toEqual([{ cols: 120, rows: 40 }]);
    expect(t.controller.status).toBe('live');
  });

  it('uses the default size when the editor has not said one', async () => {
    const t = setup();
    await t.controller.start();
    expect(t.windows).toEqual([DEFAULT_WINDOW]);
  });

  it('opens only one shell however many times it is started', async () => {
    const t = setup();
    await t.controller.start();
    await t.controller.start();
    expect(t.shells).toHaveLength(1);
  });

  it('moves into the start folder with a quoted cd, and not at all without one', async () => {
    const withFolder = setup({ cwd: "/srv/it's here" });
    await withFolder.controller.start();
    expect(withFolder.shells[0]?.written).toEqual(["cd -- '/srv/it'\\''s here'\n"]);
    const without = setup();
    await without.controller.start();
    expect(without.shells[0]?.written).toEqual([]);
  });

  it('shows why it could not connect and tries again on a key', async () => {
    const t = setup();
    t.fail(new DbError('auth-failed', 'SSH login failed for deploy@host:22'));
    await t.controller.start();
    expect(t.controller.status).toBe('ended');
    expect(t.text()).toContain('SSH login failed for deploy@host:22');
    expect(t.text()).toContain('Press any key to try again');
    t.fail(undefined);
    t.controller.input('x');
    await settle();
    expect(t.controller.status).toBe('live');
    expect(t.shells).toHaveLength(1);
  });

  it('describes an error that is not ours too', async () => {
    const t = setup();
    t.fail(new Error('boom'));
    await t.controller.start();
    expect(t.text()).toContain('boom');
  });

  it('ignores keys while it is still connecting', async () => {
    let release!: (shell: ShellSession) => void;
    const shell = new FakeShell();
    const t = setup({
      open: () =>
        new Promise<ShellSession>((resolve) => {
          release = resolve;
        }),
    });
    const starting = t.controller.start();
    t.controller.input('x');
    release(shell);
    await starting;
    expect(shell.written).toEqual([]);
  });
});

describe('TerminalController: typing and resizing', () => {
  it('passes every key on untouched, Ctrl+C and escape sequences included', async () => {
    const t = setup();
    await t.controller.start();
    for (const key of ['l', 's', '\r', '\u0003', '\u001b[A', 'щ', '✓']) {
      t.controller.input(key);
    }
    expect(t.shells[0]?.written).toEqual(['l', 's', '\r', '\u0003', '\u001b[A', 'щ', '✓']);
  });

  it('passes a resize on to the server while live', async () => {
    const t = setup();
    await t.controller.start();
    t.controller.resize({ cols: 90, rows: 25 });
    expect(t.shells[0]?.windows).toEqual([{ cols: 90, rows: 25 }]);
  });

  it('remembers a resize made before the shell opened or after it ended', async () => {
    const t = setup();
    t.controller.resize({ cols: 70, rows: 20 });
    await t.controller.start();
    expect(t.windows).toEqual([{ cols: 70, rows: 20 }]);
    t.shells[0]?.end({ reason: 'exit', code: 0 });
    await settle();
    t.controller.resize({ cols: 66, rows: 22 });
    expect(t.shells[0]?.windows).toEqual([]);
    t.controller.input('x');
    await settle();
    expect(t.windows.at(-1)).toEqual({ cols: 66, rows: 22 });
  });
});

describe('TerminalController: output', () => {
  it('hands output to the screen in batches, not chunk by chunk', async () => {
    const t = setup();
    await t.controller.start();
    const before = t.screen.length;
    t.shells[0]?.print('a');
    t.shells[0]?.print('b');
    t.shells[0]?.print('c');
    expect(t.screen).toHaveLength(before);
    expect(t.clock.waiting).toBe(1);
    t.clock.tick();
    expect(t.screen.slice(before)).toEqual(['abc']);
    expect(t.clock.waiting).toBe(0);
    expect(FLUSH_MS).toBeGreaterThan(0);
  });

  it('keeps a character whole when its bytes arrive in two chunks', async () => {
    const t = setup();
    await t.controller.start();
    const bytes = Buffer.from('щ✓😀');
    for (const byte of bytes) {
      t.shells[0]?.print(Buffer.from([byte]));
    }
    t.clock.tick();
    expect(t.text().endsWith('щ✓😀')).toBe(true);
    expect(t.text()).not.toContain('�');
  });

  it('hands out a large pile in pieces and never splits a pair of code units', async () => {
    const t = setup();
    await t.controller.start();
    const before = t.screen.length;
    // The piece boundary falls between the two halves of an emoji.
    const text = 'a'.repeat(FLUSH_CHARS - 1) + '😀' + 'b'.repeat(10);
    t.shells[0]?.print(text);
    t.clock.tick();
    const first = t.screen[before] ?? '';
    expect(first).toBe('a'.repeat(FLUSH_CHARS - 1));
    expect(t.clock.waiting).toBe(1);
    t.clock.tick();
    expect(t.screen.slice(before).join('')).toBe(text);
    expect(t.clock.waiting).toBe(0);
  });

  it('tells the server to wait when too much is waiting, and to go on once it is down', async () => {
    const t = setup();
    await t.controller.start();
    const shell = t.shells[0];
    shell?.print('x'.repeat(HIGH_WATER));
    expect(shell?.paused).toBe(1);
    shell?.print('y'.repeat(10));
    expect(shell?.paused).toBe(1);
    let guard = 0;
    while (t.clock.waiting > 0 && guard < 20) {
      t.clock.tick();
      guard += 1;
    }
    expect(shell?.resumed).toBe(1);
    expect(t.text().endsWith('y'.repeat(10))).toBe(true);
  });

  it('writes what is still waiting before the closing notice', async () => {
    const t = setup();
    await t.controller.start();
    t.shells[0]?.print('last words');
    t.shells[0]?.end({ reason: 'exit', code: 0 });
    await settle();
    const text = t.text();
    expect(text.indexOf('last words')).toBeGreaterThan(-1);
    expect(text.indexOf('last words')).toBeLessThan(text.indexOf('The session ended'));
  });
});

describe('TerminalController: ending and reconnecting', () => {
  it('names an exit code other than zero', async () => {
    const t = setup();
    await t.controller.start();
    t.shells[0]?.end({ reason: 'exit', code: 130 });
    await settle();
    expect(t.text()).toContain('exit code 130');
    expect(t.text()).toContain('Press any key to reconnect');
    expect(t.controller.status).toBe('ended');
  });

  it('says plainly that the session ended after a normal exit', async () => {
    const t = setup();
    await t.controller.start();
    t.shells[0]?.end({ reason: 'exit', code: 0 });
    await settle();
    expect(t.text()).toContain('The session ended.');
    expect(t.text()).not.toContain('exit code');
  });

  it('says the connection was lost when the link dropped', async () => {
    const t = setup();
    await t.controller.start();
    t.shells[0]?.end({ reason: 'dropped' });
    await settle();
    expect(t.text()).toContain('The connection was lost');
    expect(t.controller.status).toBe('ended');
  });

  it('opens a new shell on the next key, with the current size and folder', async () => {
    const t = setup({ cwd: '/srv' });
    await t.controller.start({ cols: 80, rows: 24 });
    t.shells[0]?.end({ reason: 'dropped' });
    await settle();
    t.controller.resize({ cols: 100, rows: 30 });
    t.controller.input('r');
    await settle();
    expect(t.shells).toHaveLength(2);
    expect(t.windows.at(-1)).toEqual({ cols: 100, rows: 30 });
    expect(t.shells[1]?.written).toEqual(["cd -- '/srv'\n"]);
    expect(t.controller.status).toBe('live');
  });

  it('ignores late output and a late exit of the shell it replaced', async () => {
    const t = setup();
    await t.controller.start();
    const old = t.shells[0];
    old?.end({ reason: 'dropped' });
    await settle();
    t.controller.input('r');
    await settle();
    const before = t.text();
    old?.print('ghost');
    t.clock.tick();
    expect(t.text()).toBe(before);
    expect(t.controller.status).toBe('live');
  });

  it("does not decode a new shell's output with the old shell's half character", async () => {
    const t = setup();
    await t.controller.start();
    t.shells[0]?.print(Buffer.from([0xd1]));
    t.shells[0]?.end({ reason: 'dropped' });
    await settle();
    t.controller.input('r');
    await settle();
    t.shells[1]?.print('ok');
    t.clock.tick();
    expect(t.text().endsWith('ok')).toBe(true);
  });
});

describe('TerminalController: closing', () => {
  it('ends the shell and gives the place back, once', async () => {
    const t = setup();
    await t.controller.start();
    t.controller.close();
    t.controller.close();
    t.controller.dispose();
    expect(t.shells[0]?.closes).toBe(1);
    expect(t.closedCalls).toHaveBeenCalledTimes(1);
    expect(t.controller.status).toBe('closed');
  });

  it('writes no closing notice for a shell it closed itself', async () => {
    const t = setup();
    await t.controller.start();
    t.controller.close();
    await settle();
    expect(t.text()).not.toContain('The session ended');
    expect(t.text()).not.toContain('connection was lost');
  });

  it('closes a shell that finished opening after the terminal was closed', async () => {
    let release!: (shell: ShellSession) => void;
    const shell = new FakeShell();
    const t = setup({
      open: () =>
        new Promise<ShellSession>((resolve) => {
          release = resolve;
        }),
    });
    const starting = t.controller.start();
    t.controller.close();
    release(shell);
    await starting;
    expect(shell.closes).toBe(1);
    expect(t.controller.status).toBe('closed');
  });

  it('says nothing about a login that failed after the terminal was closed', async () => {
    let fail!: (error: Error) => void;
    const t = setup({
      open: () =>
        new Promise<ShellSession>((_resolve, reject) => {
          fail = reject;
        }),
    });
    const starting = t.controller.start();
    t.controller.close();
    const before = t.text();
    fail(new Error('too late'));
    await starting;
    expect(t.text()).toBe(before);
  });

  it('stops typing and output reaching a closed terminal', async () => {
    const t = setup();
    await t.controller.start();
    const shell = t.shells[0];
    shell?.print('pending');
    t.controller.close();
    t.clock.tick();
    t.controller.input('x');
    expect(shell?.written).toEqual([]);
    expect(t.text()).not.toContain('pending');
  });
});

describe('TerminalRegistry', () => {
  it('lets a server have up to the limit and then refuses, naming the server', () => {
    const registry = new TerminalRegistry(2);
    registry.claim('a', 'Web');
    registry.claim('a', 'Web');
    expect(() => registry.claim('a', 'Web')).toThrow(/Too many terminals are open on "Web" \(2\)/u);
    try {
      registry.claim('a', 'Web');
    } catch (error) {
      expect(error).toBeInstanceOf(DbError);
    }
  });

  it('counts servers separately', () => {
    const registry = new TerminalRegistry(1);
    registry.claim('a', 'A');
    expect(() => registry.claim('b', 'B')).not.toThrow();
    expect(registry.count('a')).toBe(1);
    expect(registry.count('b')).toBe(1);
  });

  it('frees a place when released, and only once however often it is called', () => {
    const registry = new TerminalRegistry(2);
    const first = registry.claim('a', 'A');
    registry.claim('a', 'A');
    first();
    first();
    first();
    expect(registry.count('a')).toBe(1);
    expect(() => registry.claim('a', 'A')).not.toThrow();
  });

  it('forgets a server with no terminals', () => {
    const registry = new TerminalRegistry();
    const release = registry.claim('a', 'A');
    release();
    expect(registry.count('a')).toBe(0);
  });
});

describe('OutputDecoder and describeExecResult', () => {
  it('keeps the two streams apart, so half a character on one does not leak into the other', () => {
    const decoder = new OutputDecoder();
    const bytes = Buffer.from('щ');
    expect(decoder.write(bytes.subarray(0, 1), false)).toBe('');
    expect(decoder.write(Buffer.from('err'), true)).toBe('err');
    expect(decoder.write(bytes.subarray(1), false)).toBe('щ');
    expect(decoder.end()).toBe('');
  });

  it('flushes a character left half at the end', () => {
    const decoder = new OutputDecoder();
    decoder.write(Buffer.from([0xd1]), false);
    expect(decoder.end()).toBe('�');
  });

  it('describes how a command ended', () => {
    expect(describeExecResult({ code: 0 })).toBe('The command finished');
    expect(describeExecResult({ code: 2 })).toBe('The command finished with exit code 2');
    expect(describeExecResult({ signal: 'TERM' })).toBe(
      'The command was stopped by the signal TERM',
    );
    expect(describeExecResult({})).toBe('The command was stopped');
  });
});

describe('specOfServer', () => {
  const store = (found: boolean) => ({
    get: () =>
      found
        ? {
            id: 's',
            name: 'Web',
            ssh: {
              id: 'main',
              host: 'web.example',
              port: 2222,
              user: 'deploy',
              auth: 'password' as const,
            },
          }
        : undefined,
    getSshSecrets: () => Promise.resolve({ main: { password: 'pw' } }),
    getProxyPassword: () => Promise.resolve(undefined),
  });

  it('builds the chain with the secrets and the host key check', async () => {
    const check = () => Promise.resolve(true);
    const spec = await specOfServer(store(true), 's', check);
    expect(spec.hops).toMatchObject([
      { host: 'web.example', port: 2222, user: 'deploy', auth: 'password', password: 'pw' },
    ]);
    expect(spec.checkHostKey).toBe(check);
  });

  it('refuses a server that was removed meanwhile', async () => {
    await expect(
      specOfServer(store(false), 's', () => Promise.resolve(true)),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
