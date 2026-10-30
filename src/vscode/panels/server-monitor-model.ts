// What the server monitor page (V8.5) shows, free of `vscode`: which server it is, its
// sessions, settings and status, rates between two readings, and stopping a session.
// Every read goes through one queue: the monitor has one session of its own.

import { DbError, errorMessage } from '../../core/errors';
import type { Dialect, Session } from '../../drivers/driver';
import {
  type MonitorServer,
  monitorFeatures,
  monitorServerOf,
  SERVER_NAMES,
} from '../../services/monitor/monitor-server';
import {
  listProcesses,
  type ServerProcess,
  type StopKind,
  stopProcess,
} from '../../services/monitor/processes';
import { listSettings } from '../../services/monitor/settings';
import { readStatus } from '../../services/monitor/status';
import type { SqlDriverId } from '../../shared/connection';
import type {
  MonitorProcess,
  MonitorScope,
  MonitorSetting,
  MonitorStatusRow,
  MonitorSummary,
  ServerMonitorState,
} from '../../shared/protocols/server-monitor';

export interface ServerMonitorModelDeps {
  readonly connectionName: string;
  readonly driver: SqlDriverId;
  readonly dialect: Pick<Dialect, 'literal'>;
  readonly readOnly: boolean;
  /** The monitor's own session, opened on first use. */
  readonly session: () => Promise<Session>;
  readonly now?: () => number;
}

interface Reading {
  readonly at: number;
  readonly values: ReadonlyMap<string, number>;
  readonly rateTotal?: number;
}

export class ServerMonitorModel {
  private server: MonitorServer | undefined;
  private error: string | undefined;
  private listed: readonly ServerProcess[] = [];
  private previous: Reading | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ServerMonitorModelDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  get started(): boolean {
    return this.server !== undefined || this.error !== undefined;
  }

  /** Finds out which server this is; a failure is shown on the page, not thrown. */
  async start(): Promise<void> {
    try {
      this.server = await this.exclusive(async () =>
        monitorServerOf(await this.deps.session(), this.deps.driver),
      );
      this.error = undefined;
    } catch (error) {
      this.error = errorMessage(error);
    }
  }

  state(): ServerMonitorState {
    const server = this.server;
    return {
      connectionName: this.deps.connectionName,
      readOnly: this.deps.readOnly,
      ...(server === undefined
        ? {}
        : {
            server: SERVER_NAMES[server],
            features: (({ processes, cancel, terminate, scopes, serverScope }) => ({
              processes,
              cancel,
              terminate,
              scopes: [...scopes],
              serverScope,
            }))(monitorFeatures(server)),
          }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  async processes(): Promise<{ rows: MonitorProcess[]; at: number }> {
    const server = this.known();
    const listed = await this.exclusive(async () =>
      listProcesses(await this.deps.session(), server),
    );
    this.listed = listed;
    // The id of the running statement stays in the host; the page stops by session.
    return { rows: listed.map(({ queryId: _queryId, ...shown }) => shown), at: this.now };
  }

  async settings(scope: MonitorScope): Promise<MonitorSetting[]> {
    const server = this.known();
    if (!monitorFeatures(server).scopes.includes(scope)) {
      throw new DbError('unsupported', 'The server has no settings of this kind');
    }
    return await this.exclusive(async () => listSettings(await this.deps.session(), server, scope));
  }

  async status(): Promise<{ rows: MonitorStatusRow[]; summary: MonitorSummary; at: number }> {
    const server = this.known();
    const status = await this.exclusive(async () => readStatus(await this.deps.session(), server));
    const at = this.now;
    const previous = this.previous;
    const seconds = previous === undefined ? 0 : (at - previous.at) / 1000;
    const values = new Map<string, number>();
    const rows = status.values.map((row): MonitorStatusRow => {
      const key = `${row.group ?? ''}\u0000${row.name}`;
      const number = numeric(row.value);
      if (number === undefined) {
        return { ...row };
      }
      values.set(key, number);
      const before = previous?.values.get(key);
      return before === undefined || before === number || seconds <= 0
        ? { ...row }
        : { ...row, perSecond: (number - before) / seconds };
    });
    const { rate: total, ...summary } = status.summary;
    const before = previous?.rateTotal;
    this.previous = {
      at,
      values,
      ...(total === undefined ? {} : { rateTotal: total.total }),
    };
    // A counter that went back means the server restarted: no rate this time.
    const perSecond =
      total === undefined || before === undefined || seconds <= 0 || total.total < before
        ? undefined
        : (total.total - before) / seconds;
    return {
      rows,
      summary: {
        ...summary,
        ...(total === undefined || perSecond === undefined
          ? {}
          : { rate: { kind: total.kind, perSecond } }),
      },
      at,
    };
  }

  /** A process of the last list, for the question before stopping it. */
  process(id: string): ServerProcess | undefined {
    return this.listed.find((one) => one.id === id);
  }

  /**
   * Stops a process of the last list; the caller has asked the user. False when the
   * server says it was already gone.
   */
  async stop(id: string, kind: StopKind): Promise<boolean> {
    const server = this.known();
    if (this.deps.readOnly) {
      throw new DbError(
        'permission-denied',
        'The connection is read-only, so DataNest stops nothing on it',
      );
    }
    const features = monitorFeatures(server);
    if (!(kind === 'cancel' ? features.cancel : features.terminate)) {
      throw new DbError('unsupported', 'The server cannot stop a process this way');
    }
    const target = this.process(id);
    if (target === undefined) {
      throw new DbError('not-found', 'The process is no longer in the list; refresh it');
    }
    if (target.mine) {
      throw new DbError('unsupported', 'This is the session of the monitor itself');
    }
    return await this.exclusive(async () =>
      stopProcess(await this.deps.session(), server, target, kind, this.deps.dialect),
    );
  }

  private known(): MonitorServer {
    if (this.server === undefined) {
      throw new DbError('busy', this.error ?? 'The monitor is still connecting');
    }
    return this.server;
  }

  private async exclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return await run;
  }
}

/** Numbers as servers print them; versions, flags and addresses are not. */
function numeric(text: string): number | undefined {
  if (!/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(text.trim())) {
    return undefined;
  }
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}
