// The history of executed statements: what ran, where, when and how it went. It is
// kept in the editor's global state, so it must never hold a secret: SQL goes through
// the same redaction as the logs (ARCHITECTURE.md §8), and an entry that had
// something masked is flagged, because running it again would not do what it did.

import { type Disposable, toDisposable } from '../core/disposable';
import type { Logger } from '../core/logging/logger';
import { redactSecrets } from '../core/logging/redact';
import {
  array,
  boolean,
  literal,
  number,
  object,
  optional,
  type Schema,
  string,
} from '../shared/schema';
import type { KeyValueState } from './connection-store';

export const HISTORY_STATE_KEY = 'queryHistory';

/** Entries kept unless the setting says otherwise. */
export const DEFAULT_HISTORY_LIMIT = 500;

/** A statement longer than this is not worth keeping: nobody reruns a dump from history. */
export const MAX_HISTORY_SQL_LENGTH = 100_000;

/** Longest error text kept with an entry. */
const MAX_ERROR_LENGTH = 1000;

export interface HistoryEntry {
  readonly id: string;
  readonly sql: string;
  readonly connectionId: string;
  /** The connection's name when it ran, for a connection that has since been removed. */
  readonly connectionName: string;
  readonly database?: string | undefined;
  /** When it last ran, in milliseconds since the epoch. */
  readonly executedAt: number;
  readonly durationMs: number;
  readonly ok: boolean;
  /** Rows a SELECT returned. */
  readonly rows?: number | undefined;
  /** Rows a write reported. */
  readonly affected?: number | undefined;
  readonly error?: string | undefined;
  /** How many times in a row the very same statement ran on this connection. */
  readonly runs: number;
  /** True when a secret was masked, so the text no longer runs as it did. */
  readonly redacted?: boolean | undefined;
}

const entrySchema: Schema<HistoryEntry> = object({
  id: string({ minLength: 1, maxLength: 100 }),
  sql: string({ maxLength: MAX_HISTORY_SQL_LENGTH }),
  connectionId: string({ minLength: 1, maxLength: 100 }),
  connectionName: string({ maxLength: 1000 }),
  database: optional(string({ maxLength: 1000 })),
  executedAt: number({ min: 0 }),
  durationMs: number({ min: 0 }),
  ok: boolean(),
  rows: optional(number({ integer: true, min: 0 })),
  affected: optional(number({ integer: true, min: 0 })),
  error: optional(string({ maxLength: MAX_ERROR_LENGTH })),
  runs: number({ integer: true, min: 1 }),
  redacted: optional(boolean()),
});

const stateSchema = object({
  version: literal(1),
  items: array(entrySchema, { maxLength: 100_000 }),
});

/** What the runner reports about one finished statement. */
export interface HistoryRecord {
  readonly sql: string;
  readonly connectionId: string;
  readonly database?: string | undefined;
  readonly durationMs: number;
  readonly rows?: number | undefined;
  readonly affected?: number | undefined;
  readonly error?: string | undefined;
}

/** The part of the history the runner needs; absent where nothing is recorded. */
export interface HistoryRecorder {
  record(entry: HistoryRecord): void;
}

export interface HistoryQuery {
  /** Case-insensitive text the statement must contain; every word must be there. */
  readonly text?: string;
  readonly connectionId?: string;
  readonly onlyFailed?: boolean;
  /** Only statements that mention this table, whatever the quoting around its name. */
  readonly table?: string;
}

/** True when the statement names the table as a whole word, quoted or not. */
export function mentionsTable(sql: string, table: string): boolean {
  const name = table.trim().toLowerCase();
  if (name === '') {
    return true;
  }
  const text = sql.toLowerCase();
  let from = text.indexOf(name);
  while (from >= 0) {
    const before = text[from - 1];
    const after = text[from + name.length];
    const isWord = (char: string | undefined): boolean =>
      char !== undefined && /[\p{L}\p{N}_$]/u.test(char);
    if (!isWord(before) && !isWord(after)) {
      return true;
    }
    from = text.indexOf(name, from + 1);
  }
  return false;
}

export interface QueryHistoryDeps {
  readonly state: KeyValueState;
  readonly logger: Logger;
  /** How many entries to keep; zero or less turns recording off. */
  readonly limit: () => number;
  /** The current name of a connection, or undefined once it is gone. */
  readonly nameOf: (connectionId: string) => string | undefined;
  readonly now?: () => number;
}

export class QueryHistory implements HistoryRecorder {
  private items: HistoryEntry[];
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private readonly logger: Logger;

  constructor(private readonly deps: QueryHistoryDeps) {
    this.logger = deps.logger.child('history');
    this.items = this.load();
  }

  /** Newest first. */
  list(query: HistoryQuery = {}): HistoryEntry[] {
    const words = (query.text ?? '')
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word !== '');
    return this.items
      .filter((entry) => {
        if (query.connectionId !== undefined && entry.connectionId !== query.connectionId) {
          return false;
        }
        if (query.onlyFailed === true && entry.ok) {
          return false;
        }
        if (query.table !== undefined && !mentionsTable(entry.sql, query.table)) {
          return false;
        }
        const haystack = entry.sql.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .reverse();
  }

  get(id: string): HistoryEntry | undefined {
    return this.items.find((entry) => entry.id === id);
  }

  get size(): number {
    return this.items.length;
  }

  /** The connections that have entries, for the filter. */
  connections(): { id: string; name: string; count: number }[] {
    const seen = new Map<string, { id: string; name: string; count: number }>();
    for (const entry of [...this.items].reverse()) {
      const known = seen.get(entry.connectionId);
      if (known === undefined) {
        // The newest entry has the freshest name, unless the connection is gone.
        seen.set(entry.connectionId, {
          id: entry.connectionId,
          name: this.deps.nameOf(entry.connectionId) ?? entry.connectionName,
          count: 1,
        });
      } else {
        known.count += 1;
      }
    }
    return [...seen.values()];
  }

  record(record: HistoryRecord): void {
    const limit = Math.trunc(this.deps.limit());
    const original = record.sql.trim();
    if (limit <= 0 || original === '' || original.length > MAX_HISTORY_SQL_LENGTH) {
      return;
    }
    const sql = redactSecrets(original);
    const redacted = sql !== original;
    const now = (this.deps.now ?? Date.now)();
    const connectionName = this.deps.nameOf(record.connectionId) ?? record.connectionId;
    const base = {
      sql,
      connectionId: record.connectionId,
      connectionName,
      ...(record.database === undefined ? {} : { database: record.database }),
      executedAt: now,
      durationMs: Math.max(0, Math.round(record.durationMs)),
      ok: record.error === undefined,
      ...(record.rows === undefined ? {} : { rows: record.rows }),
      ...(record.affected === undefined ? {} : { affected: record.affected }),
      ...(record.error === undefined ? {} : { error: record.error.slice(0, MAX_ERROR_LENGTH) }),
      ...(redacted ? { redacted: true } : {}),
    };
    const last = this.items.at(-1);
    if (
      last?.sql === sql &&
      last.connectionId === record.connectionId &&
      last.database === record.database
    ) {
      // The same statement again: one line with a counter beats a screenful of copies.
      this.items[this.items.length - 1] = { ...base, id: last.id, runs: last.runs + 1 };
    } else {
      this.items.push({ ...base, id: this.newId(now), runs: 1 });
    }
    this.trim(limit);
    this.persist();
  }

  remove(id: string): boolean {
    const before = this.items.length;
    this.items = this.items.filter((entry) => entry.id !== id);
    if (this.items.length === before) {
      return false;
    }
    this.persist();
    return true;
  }

  /** Forgets everything, or only one connection's entries. Returns how many went. */
  clear(connectionId?: string): number {
    const before = this.items.length;
    this.items =
      connectionId === undefined
        ? []
        : this.items.filter((entry) => entry.connectionId !== connectionId);
    const removed = before - this.items.length;
    if (removed > 0) {
      this.persist();
    }
    return removed;
  }

  /** Applies a smaller limit right away, e.g. after the setting changed. */
  enforceLimit(): void {
    const limit = Math.trunc(this.deps.limit());
    const before = this.items.length;
    if (limit <= 0) {
      this.items = [];
    } else {
      this.trim(limit);
    }
    if (this.items.length !== before) {
      this.persist();
    }
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  private trim(limit: number): void {
    if (this.items.length > limit) {
      this.items = this.items.slice(this.items.length - limit);
    }
  }

  private newId(now: number): string {
    return `${now.toString(36)}-${(this.nextId++).toString(36)}`;
  }

  private load(): HistoryEntry[] {
    const raw = this.deps.state.get(HISTORY_STATE_KEY);
    if (raw === undefined) {
      return [];
    }
    try {
      return [...stateSchema.parse(raw).items];
    } catch (error) {
      // A damaged history is not worth refusing to start; it starts over.
      this.logger.warn('The saved query history is unreadable and was dropped', error);
      return [];
    }
  }

  private persist(): void {
    void Promise.resolve(
      this.deps.state.update(HISTORY_STATE_KEY, { version: 1, items: this.items }),
    ).catch((error: unknown) => {
      this.logger.warn('Could not save the query history', error);
    });
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        this.logger.warn('A history listener failed', error);
      }
    }
  }
}
