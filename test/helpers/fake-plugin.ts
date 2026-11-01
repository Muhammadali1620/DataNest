// A driver as another extension would write it, for tests of the plugin API (V12.7):
// in memory, with a script of what each statement answers.

import type { PluginDriver, PluginEvent, PluginMetadata, PluginSession } from '../../src/api/types';

export interface FakePluginOptions {
  readonly id?: string;
  readonly events?: (sql: string) => PluginEvent[] | Promise<PluginEvent[]>;
  readonly metadata?: Partial<PluginMetadata>;
  readonly withCancel?: boolean;
}

export class FakePluginSession implements PluginSession {
  readonly executed: string[] = [];
  readonly executeOptions: ({ readonly rowLimit?: number } | undefined)[] = [];
  closed = 0;
  cancelled = 0;
  readonly metadata: PluginMetadata;
  cancel?: () => Promise<void>;

  constructor(private readonly options: FakePluginOptions) {
    this.metadata = {
      listTables: () => Promise.resolve([{ name: 'people' }, { name: 'v', kind: 'view' }]),
      listColumns: () =>
        Promise.resolve([
          { name: 'id', dataType: 'integer', primaryKey: true, nullable: false },
          { name: 'name', dataType: 'text' },
        ]),
      ...options.metadata,
    };
    if (options.withCancel === true) {
      this.cancel = () => {
        this.cancelled += 1;
        return Promise.resolve();
      };
    }
  }

  async *execute(
    sql: string,
    options?: { readonly rowLimit?: number },
  ): AsyncIterable<PluginEvent> {
    this.executed.push(sql);
    this.executeOptions.push(options);
    const events = await (this.options.events?.(sql) ?? [
      { kind: 'columns', columns: [{ name: 'one' }] },
      { kind: 'rows', rows: [[1]] },
      { kind: 'done' },
    ]);
    for (const event of events) {
      yield event;
    }
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

export class FakePlugin implements PluginDriver {
  readonly id: string;
  readonly label = 'Fake DB';
  readonly fields = ['host', 'port', 'user', 'password', 'database', 'file'] as const;
  readonly defaultPort = 4000;
  readonly sessions: FakePluginSession[] = [];
  readonly opened: unknown[] = [];
  failWith: Error | undefined;

  constructor(private readonly options: FakePluginOptions = {}) {
    this.id = options.id ?? 'acme.fake';
  }

  openSession(connection: unknown): Promise<PluginSession> {
    this.opened.push(connection);
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    const session = new FakePluginSession(this.options);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}

/** A plain descriptor object (the spread of a class instance would lose `openSession`). */
export function descriptor(overrides: Partial<PluginDriver> = {}): PluginDriver {
  const plugin = new FakePlugin();
  return {
    id: plugin.id,
    label: plugin.label,
    fields: plugin.fields,
    defaultPort: plugin.defaultPort,
    openSession: (connection) => plugin.openSession(connection),
    ...overrides,
  };
}
