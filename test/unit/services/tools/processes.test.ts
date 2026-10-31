import { describe, expect, it, vi } from 'vitest';
import {
  MAX_PROCESSES,
  type ProcessDeps,
  ProcessTools,
} from '../../../../src/services/tools/processes';

const PS =
  '    1 root   0.0 100 00:10 /sbin/init\n  500 alice  2.5 2048 01:00 /usr/bin/node app.js\n';

function tools(over: Partial<ProcessDeps> = {}) {
  const exec = vi.fn((_file: string, _args: string[]): Promise<string> => {
    return Promise.resolve(PS);
  });
  const kill = vi.fn();
  const deps: ProcessDeps = {
    platform: 'linux',
    exec,
    kill,
    currentUser: () => 'alice',
    protectedPids: [900, 899],
    now: () => Date.parse('2026-10-31T12:00:00Z'),
    ...over,
  };
  return { tools: new ProcessTools(deps), exec, kill };
}

describe('list', () => {
  it('runs ps with a wide user column on Linux', async () => {
    const { tools: t, exec } = tools();
    const list = await t.list();
    expect(exec).toHaveBeenCalledWith('ps', [
      '-ww',
      '-eo',
      'pid=,user:32=,pcpu=,rss=,etime=,args=',
    ]);
    expect(list).toMatchObject({ platform: 'linux', currentUser: 'alice', truncated: false });
    expect(list.items.map((i) => i.pid)).toEqual([1, 500]);
  });

  it('uses the plain user column on macOS', async () => {
    const { tools: t, exec } = tools({ platform: 'darwin' });
    await t.list();
    expect(exec).toHaveBeenCalledWith('ps', ['-ww', '-eo', 'pid=,user=,pcpu=,rss=,etime=,args=']);
  });

  it('asks PowerShell and tasklist on Windows and joins the accounts', async () => {
    const json = JSON.stringify([
      {
        ProcessId: 4321,
        Name: 'chrome.exe',
        CommandLine: 'chrome.exe',
        WorkingSetSize: 2048,
        Start: null,
        CpuMs: 1,
      },
    ]);
    const csv = '"chrome.exe","4321","Console","1","1 K","Running","PC\\alice","0:00:01","x"';
    const exec = vi.fn((file: string): Promise<string> =>
      Promise.resolve(file === 'powershell.exe' ? json : csv),
    );
    const { tools: t } = tools({ platform: 'win32', exec });
    const list = await t.list();
    expect(exec.mock.calls.map((call) => call[0])).toEqual(['powershell.exe', 'tasklist.exe']);
    expect(list.items).toMatchObject([{ pid: 4321, user: 'PC\\alice', memoryKb: 2 }]);
  });

  it('still lists processes on Windows when tasklist fails', async () => {
    const json = JSON.stringify([{ ProcessId: 7, Name: 'a.exe' }]);
    const exec = vi.fn((file: string): Promise<string> =>
      file === 'powershell.exe' ? Promise.resolve(json) : Promise.reject(new Error('no tasklist')),
    );
    const { tools: t } = tools({ platform: 'win32', exec });
    expect((await t.list()).items).toMatchObject([{ pid: 7, user: '' }]);
  });

  it('lets a failing system tool surface to the caller', async () => {
    const { tools: t } = tools({ exec: () => Promise.reject(new Error('ps is missing')) });
    await expect(t.list()).rejects.toThrow('ps is missing');
  });

  it('caps the list and says so', async () => {
    const many = Array.from(
      { length: MAX_PROCESSES + 5 },
      (_, i) => `${i + 10} u 0.0 1 00:01 p${i}`,
    ).join('\n');
    const { tools: t } = tools({ exec: () => Promise.resolve(many) });
    const list = await t.list();
    expect(list.items).toHaveLength(MAX_PROCESSES);
    expect(list.truncated).toBe(true);
  });
});

describe('kill', () => {
  it('sends SIGTERM, or SIGKILL when forced', () => {
    const { tools: t, kill } = tools();
    expect(t.kill(500, false)).toEqual({ ok: true });
    expect(kill).toHaveBeenLastCalledWith(500, 'SIGTERM');
    expect(t.kill(500, true)).toEqual({ ok: true });
    expect(kill).toHaveBeenLastCalledWith(500, 'SIGKILL');
  });

  it('refuses a pid that is not a process, init, and the editor itself', () => {
    const { tools: t, kill } = tools();
    for (const pid of [0, 1, -5, 1.5, Number.NaN]) {
      expect(t.kill(pid, false)).toEqual({ ok: false, error: 'invalid-pid' });
    }
    expect(t.kill(900, false)).toEqual({ ok: false, error: 'protected' });
    expect(t.kill(899, true)).toEqual({ ok: false, error: 'protected' });
    expect(kill).not.toHaveBeenCalled();
    expect(t.check(1)).toBe('invalid-pid');
    expect(t.check(900)).toBe('protected');
    expect(t.check(500)).toBeUndefined();
  });

  it('maps the system errors', () => {
    const fail = (code: string) => () => {
      throw Object.assign(new Error('x'), { code });
    };
    expect(tools({ kill: fail('EPERM') }).tools.kill(500, false)).toEqual({
      ok: false,
      error: 'denied',
    });
    expect(tools({ kill: fail('ESRCH') }).tools.kill(500, false)).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(tools({ kill: fail('EIO') }).tools.kill(500, false)).toEqual({
      ok: false,
      error: 'failed',
    });
    expect(
      tools({
        kill: () => {
          throw new Error('plain');
        },
      }).tools.kill(500, false),
    ).toEqual({ ok: false, error: 'failed' });
  });
});
