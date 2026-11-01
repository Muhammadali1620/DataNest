// Which result tabs a saved SQL file had (V13.12), so they come back after the editor
// restarts. Only what is needed to run a statement again is kept — its text and the
// connection it ran on — never rows, never a password, and only statements that merely
// read. Rows live in the host's memory by design (D6); the tab returns empty, with a
// button to run it. Kept in the workspace state, like the bindings of files.

import type { Disposable } from '../core/disposable';
import { isKeptDocument } from './binding-memory';
import type { SessionTarget } from './connection-manager';
import type { KeyValueState } from './connection-store';
import type { ResultSummary, RestoredResult } from './result-store';

const STATE_KEY = 'datanest.rememberedResults';

/** Files whose tabs are kept; the ones touched longest ago are forgotten first. */
export const MAX_REMEMBERED_FILES = 30;

/** Tabs kept per file. */
export const MAX_REMEMBERED_TABS = 20;

/** A longer statement is not kept: a huge script is not worth the state. */
export const MAX_REMEMBERED_STATEMENT = 20_000;

/** One tab, as stored. */
export interface RememberedTab {
  readonly statement: string;
  readonly statementStart: number;
  readonly pinned: boolean;
  readonly target: SessionTarget;
}

type Stored = readonly (readonly [string, readonly RememberedTab[]])[];

function isTarget(value: unknown): value is SessionTarget {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { connectionId, database } = value as Record<string, unknown>;
  return (
    typeof connectionId === 'string' &&
    connectionId !== '' &&
    (database === undefined || typeof database === 'string')
  );
}

function isTab(value: unknown): value is RememberedTab {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { statement, statementStart, pinned, target } = value as Record<string, unknown>;
  return (
    typeof statement === 'string' &&
    statement.trim() !== '' &&
    statement.length <= MAX_REMEMBERED_STATEMENT &&
    typeof statementStart === 'number' &&
    Number.isFinite(statementStart) &&
    typeof pinned === 'boolean' &&
    isTarget(target)
  );
}

/** Whatever the state holds that does not look right is dropped, never trusted. */
function parse(value: unknown): Map<string, RememberedTab[]> {
  const kept = new Map<string, RememberedTab[]>();
  if (!Array.isArray(value)) {
    return kept;
  }
  for (const entry of value as unknown[]) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      continue;
    }
    const [uri, tabs] = entry as [unknown, unknown];
    if (typeof uri !== 'string' || !isKeptDocument(uri) || !Array.isArray(tabs)) {
      continue;
    }
    const good = (tabs as unknown[]).filter(isTab).slice(0, MAX_REMEMBERED_TABS);
    if (good.length > 0) {
      kept.set(uri, good.map(copyTab));
    }
  }
  return kept;
}

function copyTab(tab: RememberedTab): RememberedTab {
  return {
    statement: tab.statement,
    statementStart: Math.max(0, Math.trunc(tab.statementStart)),
    pinned: tab.pinned,
    target: {
      connectionId: tab.target.connectionId,
      ...(tab.target.database === undefined ? {} : { database: tab.target.database }),
    },
  };
}

function sameTabs(a: readonly RememberedTab[] | undefined, b: readonly RememberedTab[]): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

export class ResultMemory {
  constructor(private readonly state: KeyValueState) {}

  /** The tabs a file had, oldest first; empty when none were kept. */
  get(documentUri: string): RememberedTab[] {
    return this.read().get(documentUri) ?? [];
  }

  /**
   * Keeps the tabs a file has now. Untitled documents are skipped (they do not outlive the
   * editor); no tabs means the file has nothing to bring back, so its record goes.
   */
  async remember(documentUri: string, tabs: readonly RememberedTab[]): Promise<void> {
    if (!isKeptDocument(documentUri)) {
      return;
    }
    const kept = this.read();
    const next = tabs.filter(isTab).slice(-MAX_REMEMBERED_TABS).map(copyTab);
    if (next.length === 0) {
      if (kept.delete(documentUri)) {
        await this.write(kept);
      }
      return;
    }
    if (sameTabs(kept.get(documentUri), next)) {
      return;
    }
    // Delete first, so the file moves to the end: the most recently touched is kept longest.
    kept.delete(documentUri);
    kept.set(documentUri, next);
    await this.write(kept);
  }

  /** A renamed or moved file keeps its tabs under its new name. */
  async rename(from: string, to: string): Promise<void> {
    const kept = this.read();
    const tabs = kept.get(from);
    if (tabs === undefined) {
      return;
    }
    kept.delete(from);
    if (isKeptDocument(to)) {
      kept.delete(to);
      kept.set(to, tabs);
    }
    await this.write(kept);
  }

  private read(): Map<string, RememberedTab[]> {
    return parse(this.state.get(STATE_KEY));
  }

  private async write(kept: Map<string, RememberedTab[]>): Promise<void> {
    const entries: Stored = [...kept].slice(-MAX_REMEMBERED_FILES);
    await this.state.update(STATE_KEY, entries);
  }
}

/** What the recorder and the restorer ask about a statement and its connection. */
export interface RememberRules {
  /** True when the statement only reads, so running it again is safe. */
  isReadOnly(statement: string, connectionId: string): boolean;
}

/** The tab of a result, or undefined when it should not be kept. */
export function tabOf(summary: ResultSummary, rules: RememberRules): RememberedTab | undefined {
  const target = summary.origin?.target;
  const statement = summary.statement;
  if (
    target === undefined ||
    summary.error !== undefined ||
    summary.page !== undefined ||
    statement.trim() === '' ||
    statement.length > MAX_REMEMBERED_STATEMENT ||
    !rules.isReadOnly(statement, target.connectionId)
  ) {
    return undefined;
  }
  return {
    statement,
    statementStart: summary.statementStart,
    pinned: summary.pinned,
    target: {
      connectionId: target.connectionId,
      ...(target.database === undefined ? {} : { database: target.database }),
    },
  };
}

/** The slice of the result store the recorder reads. */
export interface RecordedResults {
  forDocument(documentUri: string): ResultSummary[];
  onDidChange(listener: (documentUri: string) => void): Disposable;
}

/**
 * Keeps the memory in step with the tabs: after every change of a file's results the
 * rememberable ones are written. A file that has no results at all (it was just closed,
 * perhaps because the editor is shutting down) is left alone.
 */
export function recordResults(
  results: RecordedResults,
  memory: Pick<ResultMemory, 'remember'>,
  rules: RememberRules,
  onError: (error: unknown) => void = () => undefined,
): Disposable {
  return results.onDidChange((documentUri) => {
    if (!isKeptDocument(documentUri)) {
      return;
    }
    const summaries = results.forDocument(documentUri);
    if (summaries.length === 0) {
      return;
    }
    const tabs = summaries.flatMap((summary) => {
      const tab = tabOf(summary, rules);
      return tab === undefined ? [] : [tab];
    });
    memory.remember(documentUri, tabs).catch(onError);
  });
}

function keyOf(statement: string, target: SessionTarget | undefined): string {
  return JSON.stringify([statement, target?.connectionId, target?.database]);
}

/** What the restorer needs to know about a connection. */
export interface RestorableConnection {
  readonly disabled: boolean;
  readonly production: boolean;
}

export interface ResultRestorerDeps {
  readonly memory: Pick<ResultMemory, 'get'>;
  readonly results: {
    forDocument(documentUri: string): ResultSummary[];
    addRestored(result: RestoredResult): ResultSummary;
  };
  /** The connection, or undefined when it was deleted. */
  readonly connectionOf: (connectionId: string) => RestorableConnection | undefined;
  readonly rules: RememberRules;
  /** Runs a restored tab in place; absent until the editor is ready for it. */
  readonly run?: (request: {
    documentUri: string;
    target: SessionTarget;
    sql: string;
    replace: { resultId: string };
  }) => Promise<unknown>;
  /** Whether restored tabs run on their own (`datanest.results.restoreRun`). */
  readonly autoRun: () => boolean;
  readonly onError?: (error: unknown) => void;
}

export interface RestoreOutcome {
  /** Tabs put back. */
  readonly restored: number;
  /** Settles when the runs started on their own are over; nothing runs unless asked. */
  readonly finished: Promise<void>;
}

/** Puts the remembered tabs of a file back, empty or — when asked to — run again. */
export class ResultRestorer {
  constructor(private readonly deps: ResultRestorerDeps) {}

  /**
   * Puts the file's remembered tabs back unless it already shows a result of its own. A
   * tab whose connection is not known yet (project connections arrive after start-up) is
   * left in the memory and comes back when `restore` is called again.
   */
  restore(documentUri: string): RestoreOutcome {
    const none: RestoreOutcome = { restored: 0, finished: Promise.resolve() };
    if (!isKeptDocument(documentUri)) {
      return none;
    }
    const existing = this.deps.results.forDocument(documentUri);
    if (existing.some((result) => result.restored !== true)) {
      return none;
    }
    const have = new Set(existing.map((result) => keyOf(result.statement, result.origin?.target)));
    const added = this.deps.memory
      .get(documentUri)
      .filter(
        (tab) =>
          this.deps.connectionOf(tab.target.connectionId) !== undefined &&
          !have.has(keyOf(tab.statement, tab.target)),
      )
      .map((tab) => ({
        tab,
        summary: this.deps.results.addRestored({
          documentUri,
          statement: tab.statement,
          statementStart: tab.statementStart,
          target: tab.target,
          pinned: tab.pinned,
        }),
      }));
    if (added.length === 0) {
      return none;
    }
    return { restored: added.length, finished: this.runAll(documentUri, added) };
  }

  private async runAll(
    documentUri: string,
    added: readonly { tab: RememberedTab; summary: ResultSummary }[],
  ): Promise<void> {
    const { run } = this.deps;
    if (run === undefined || !this.deps.autoRun()) {
      return;
    }
    for (const { tab, summary } of added) {
      const connection = this.deps.connectionOf(tab.target.connectionId);
      // Never on its own for a switched-off connection, nor for production: the user asks.
      if (
        connection === undefined ||
        connection.disabled ||
        connection.production ||
        !this.deps.rules.isReadOnly(tab.statement, tab.target.connectionId)
      ) {
        continue;
      }
      try {
        await run({
          documentUri,
          target: tab.target,
          sql: tab.statement,
          replace: { resultId: summary.id },
        });
      } catch (error) {
        this.deps.onError?.(error);
      }
    }
  }
}
