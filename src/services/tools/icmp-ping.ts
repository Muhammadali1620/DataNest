// ICMP ping of the Tools page: runs the system's `ping` and hands its lines on as they
// arrive. No shell, and the host was checked (it cannot start with a dash). A machine
// without the program gets `available: false`, and the page offers the TCP ping instead.

import { type ChildProcess, spawn } from 'node:child_process';
import { type PingLine, parsePingLine, pingArgs } from '../../shared/tools/icmp';
import { checkHost, clampCount, clampTimeout } from '../../shared/tools/validate';
import type { NetworkErrorCode } from '../../shared/protocols/tools';

export type SpawnPing = (file: string, args: string[]) => ChildProcess;

export interface IcmpResult {
  readonly available: boolean;
  readonly attempts: { ok: boolean; ms?: number }[];
  readonly error?: NetworkErrorCode;
}

const realSpawn: SpawnPing = (file, args) =>
  spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

export class IcmpPing {
  private readonly running = new Map<number, ChildProcess>();

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly start: SpawnPing = realSpawn,
  ) {}

  /** Stops a run; one that is not running is ignored. */
  cancel(runId: number): void {
    this.running.get(runId)?.kill();
  }

  dispose(): void {
    for (const child of this.running.values()) {
      child.kill();
    }
    this.running.clear();
  }

  run(
    runId: number,
    host: string,
    count: number,
    timeoutMs: number,
    onLine: (line: PingLine) => void,
  ): Promise<IcmpResult> {
    const checked = checkHost(host);
    if (!checked.ok) {
      return Promise.resolve({ available: true, attempts: [], error: 'invalid-host' });
    }
    const total = clampCount(count);
    const timeout = clampTimeout(timeoutMs);
    const { file, args } = pingArgs(this.platform, checked.value, total, timeout);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = this.start(file, args);
      } catch {
        resolve({ available: false, attempts: [] });
        return;
      }
      this.running.set(runId, child);
      const times: number[] = [];
      let missing = false;
      let buffer = '';
      const take = (text: string, last: boolean): void => {
        buffer += text;
        const lines = buffer.split(/\r?\n/u);
        buffer = last ? '' : (lines.pop() ?? '');
        for (const raw of lines) {
          if (raw.trim() === '') {
            continue;
          }
          const line = parsePingLine(raw);
          if (line.reply) {
            times.push(line.ms ?? 0);
          }
          onLine(line);
        }
      };
      // A hung run is stopped after the longest it could take, plus a little.
      const guard = setTimeout(
        () => {
          child.kill();
        },
        total * (timeout + 1000) + 2000,
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        take(chunk.toString('utf8'), false);
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        // Errors of ping itself (an unknown host) are lines the user should read.
        take(chunk.toString('utf8'), false);
      });
      let settled = false;
      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(guard);
        this.running.delete(runId);
        take('', true);
        if (missing) {
          resolve({ available: false, attempts: [] });
          return;
        }
        const attempts: { ok: boolean; ms?: number }[] = times.map((ms) => ({ ok: true, ms }));
        while (attempts.length < total) {
          attempts.push({ ok: false });
        }
        resolve({ available: true, attempts });
      };
      child.on('error', (error: NodeJS.ErrnoException) => {
        // A program that is not there never runs, so there is no "close" to wait for.
        missing = error.code === 'ENOENT';
        finish();
      });
      child.on('close', finish);
    });
  }
}
