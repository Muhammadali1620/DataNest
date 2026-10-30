// The checks of the server monitor (V8.5) every real server goes through: who it is,
// its sessions with a statement of another session found by a marker, cancelling that
// statement and ending a session, settings of each scope, and status with a rate.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../src/drivers/driver';
import {
  type MonitorServer,
  monitorFeatures,
  monitorServerOf,
} from '../../src/services/monitor/monitor-server';
import {
  listProcesses,
  type ServerProcess,
  stopProcess,
} from '../../src/services/monitor/processes';
import { listSettings } from '../../src/services/monitor/settings';
import { readStatus } from '../../src/services/monitor/status';
import type { ResolvedConnectionConfig, SqlDriverId } from '../../src/shared/connection';
import { runAll } from './driver-run';

/** How long a marked statement waits on the server, unless it is stopped. */
const SLOW_SECONDS = 30;
const FIND_TIMEOUT_MS = 15_000;

export interface MonitorSuiteOptions {
  readonly label: string;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  readonly server: MonitorServer;
  readonly sqlDriver: SqlDriverId;
  /** A statement that runs about 30 seconds and carries `marker` in its text. */
  readonly slow?: (marker: string) => string;
  /** A setting each scope surely has, by scope. */
  readonly settings: { readonly session: string; readonly server?: string };
  /** The summary numbers this server gives. */
  readonly summary: readonly ('uptimeSeconds' | 'connections' | 'maxConnections' | 'sizeBytes')[];
}

async function settle(run: Promise<unknown>): Promise<{ ok: boolean; ms: number }> {
  const started = Date.now();
  try {
    await run;
    return { ok: true, ms: Date.now() - started };
  } catch {
    return { ok: false, ms: Date.now() - started };
  }
}

async function findMarked(
  session: Session,
  server: MonitorServer,
  marker: string,
): Promise<ServerProcess> {
  const started = Date.now();
  for (;;) {
    const found = (await listProcesses(session, server)).find(
      (one) => one.query?.includes(marker) === true && !one.mine,
    );
    if (found !== undefined) {
      return found;
    }
    if (Date.now() - started > FIND_TIMEOUT_MS) {
      throw new Error(`No process runs ${marker}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function monitorSuite(options: MonitorSuiteOptions): void {
  describe(`server monitor on ${options.label}`, () => {
    let session: Session;
    const features = monitorFeatures(options.server);
    const dialect = (): Driver['dialect'] => options.driver().dialect;

    beforeAll(async () => {
      session = await options.driver().openSession(options.config());
    }, 60_000);

    afterAll(async () => {
      await session.close();
    });

    it('knows which server it talks to', async () => {
      expect(await monitorServerOf(session, options.sqlDriver)).toBe(options.server);
    });

    it.runIf(features.processes && options.server !== 'clickhouse')(
      'lists its own session',
      async () => {
        const processes = await listProcesses(session, options.server);
        const mine = processes.filter((one) => one.mine);
        expect(mine).toHaveLength(1);
        expect(mine[0]?.idle).toBe(false);
        for (const one of processes) {
          expect(one.id).not.toBe('');
          expect(one.seconds ?? 0).toBeGreaterThanOrEqual(0);
        }
      },
    );

    const { slow } = options;
    if (features.processes && slow !== undefined) {
      it(
        'finds the statement of another session and cancels it',
        async () => {
          const other = await options.driver().openSession(options.config());
          try {
            const marker = `dn_mon_cancel_${Date.now()}`;
            const run = settle(runAll(other, slow(marker)));
            const target = await findMarked(session, options.server, marker);
            expect(target.idle).toBe(false);
            const kind = features.cancel ? 'cancel' : 'terminate';
            expect(await stopProcess(session, options.server, target, kind, dialect())).toBe(true);
            const { ms } = await run;
            expect(ms).toBeLessThan((SLOW_SECONDS - 5) * 1000);
            if (features.cancel) {
              // Cancelling stops the statement, not the session.
              const after = await runAll(
                other,
                options.server === 'oracle' ? 'SELECT 1 FROM dual' : 'SELECT 1',
              );
              expect(after.rows).toHaveLength(1);
            }
          } finally {
            await other.close().catch(() => undefined);
          }
        },
        (SLOW_SECONDS + 10) * 1000,
      );
    }

    if (features.terminate && slow !== undefined) {
      it(
        'ends another session',
        async () => {
          const other = await options.driver().openSession(options.config());
          try {
            const marker = `dn_mon_end_${Date.now()}`;
            const run = settle(runAll(other, slow(marker)));
            const target = await findMarked(session, options.server, marker);
            expect(await stopProcess(session, options.server, target, 'terminate', dialect())).toBe(
              true,
            );
            const { ok, ms } = await run;
            expect(ok).toBe(false);
            expect(ms).toBeLessThan((SLOW_SECONDS - 5) * 1000);
            const started = Date.now();
            for (;;) {
              const left = await listProcesses(session, options.server);
              if (!left.some((one) => one.id === target.id)) {
                break;
              }
              expect(Date.now() - started).toBeLessThan(FIND_TIMEOUT_MS);
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
          } finally {
            await other.close().catch(() => undefined);
          }
        },
        (SLOW_SECONDS + 10) * 1000,
      );
    }

    it.runIf(features.processes)(
      'says a stopped process that is gone stopped nothing',
      async () => {
        const gone: Pick<ServerProcess, 'id' | 'queryId'> =
          options.server === 'oracle'
            ? { id: '99999,1' }
            : options.server === 'cockroach'
              ? { id: '17a0b1c2d3e4f5', queryId: '17a0b1c2d3e4f5' }
              : options.server === 'clickhouse'
                ? { id: 'no-such-query' }
                : { id: '999999' };
        const kind = features.cancel ? 'cancel' : 'terminate';
        const result = stopProcess(session, options.server, gone, kind, dialect());
        if (['postgres', 'clickhouse', 'mysql', 'mariadb', 'tidb'].includes(options.server)) {
          expect(await result).toBe(false);
        } else {
          await expect(result).rejects.toThrow();
        }
      },
    );

    it('reads the settings of every scope', async () => {
      for (const scope of features.scopes) {
        const settings = await listSettings(session, options.server, scope);
        const expected = scope === 'session' ? options.settings.session : options.settings.server;
        expect(settings.length).toBeGreaterThan(scope === 'session' ? 3 : 10);
        const names = settings.map((one) => one.name.toLowerCase());
        expect(names, scope).toContain(expected?.toLowerCase());
        expect([...names].sort((a, b) => a.localeCompare(b, 'en'))).toEqual(names);
      }
    });

    it('reads the status, and the rate between two readings', async () => {
      const first = await readStatus(session, options.server);
      expect(first.values.length).toBeGreaterThan(2);
      expect(first.summary.version).toMatch(/\d/u);
      for (const name of options.summary) {
        expect(first.summary[name], name).toBeGreaterThanOrEqual(0);
      }
      if (first.summary.rate !== undefined) {
        const second = await readStatus(session, options.server);
        expect(second.summary.rate?.total).toBeGreaterThanOrEqual(first.summary.rate.total);
      }
    });
  });
}
