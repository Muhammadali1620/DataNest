// The task manager of the Tools page: lists the machine's processes with the system's own
// tools and ends one on request. Every call of the system is a parameter, so the logic is
// covered by tests on text taken from each platform; `realProcessDeps` is the real one.

import { execFile } from 'node:child_process';
import { userInfo } from 'node:os';
import {
  type ProcessInfo,
  parsePs,
  parseTasklistUsers,
  parseWindowsProcesses,
} from '../../shared/tools/processes';

/** The most processes sent to the page; a real machine has a few hundred to a few thousand. */
export const MAX_PROCESSES = 6000;

export interface ProcessDeps {
  readonly platform: NodeJS.Platform;
  /** Runs a program with no shell and returns what it printed. */
  readonly exec: (file: string, args: string[]) => Promise<string>;
  readonly kill: (pid: number, signal: NodeJS.Signals) => void;
  readonly currentUser: () => string;
  /** The processes the page must never end: this one and its parent. */
  readonly protectedPids: readonly number[];
  readonly now: () => number;
}

export const realProcessDeps: ProcessDeps = {
  platform: process.platform,
  exec: (file, args) =>
    new Promise((resolve, reject) => {
      execFile(
        file,
        args,
        { maxBuffer: 128 * 1024 * 1024, timeout: 20_000, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => {
          if (error !== null && stdout === '') {
            reject(new Error(error.message));
          } else {
            resolve(stdout);
          }
        },
      );
    }),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  currentUser: () => userInfo().username,
  protectedPids: [process.pid, process.ppid],
  now: () => Date.now(),
};

const WINDOWS_QUERY =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine,WorkingSetSize,' +
  "@{n='Start';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}}," +
  "@{n='CpuMs';e={[int64](($_.KernelModeTime+$_.UserModeTime)/10000)}} | ConvertTo-Json -Compress";

export type KillError = 'invalid-pid' | 'protected' | 'denied' | 'not-found' | 'failed';

export interface ProcessList {
  readonly platform: string;
  readonly currentUser: string;
  readonly items: ProcessInfo[];
  readonly truncated: boolean;
}

export class ProcessTools {
  constructor(private readonly deps: ProcessDeps = realProcessDeps) {}

  async list(): Promise<ProcessList> {
    const { platform } = this.deps;
    let items: ProcessInfo[];
    if (platform === 'win32') {
      const [json, tasks] = await Promise.all([
        this.deps.exec('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          WINDOWS_QUERY,
        ]),
        // The account of each process is only in tasklist; without it the column stays empty.
        this.deps.exec('tasklist.exe', ['/FO', 'CSV', '/NH', '/V']).catch(() => ''),
      ]);
      items = parseWindowsProcesses(json, parseTasklistUsers(tasks), this.deps.now());
    } else {
      // Linux's ps can widen the user column; macOS's cannot and does not need it.
      const user = platform === 'linux' ? 'user:32=' : 'user=';
      items = parsePs(
        await this.deps.exec('ps', ['-ww', '-eo', `pid=,${user},pcpu=,rss=,etime=,args=`]),
      );
    }
    return {
      platform,
      currentUser: this.deps.currentUser(),
      items: items.slice(0, MAX_PROCESSES),
      truncated: items.length > MAX_PROCESSES,
    };
  }

  /** Why this process may not be ended, if it may not; checked before the user is asked. */
  check(pid: number): 'invalid-pid' | 'protected' | undefined {
    if (!Number.isInteger(pid) || pid <= 1) {
      return 'invalid-pid';
    }
    return this.deps.protectedPids.includes(pid) ? 'protected' : undefined;
  }

  /** Sends the termination signal; `force` is SIGKILL where the system has it. */
  kill(pid: number, force: boolean): { ok: true } | { ok: false; error: KillError } {
    const refused = this.check(pid);
    if (refused !== undefined) {
      return { ok: false, error: refused };
    }
    try {
      this.deps.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
      return { ok: true };
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      return {
        ok: false,
        error: code === 'EPERM' ? 'denied' : code === 'ESRCH' ? 'not-found' : 'failed',
      };
    }
  }
}
