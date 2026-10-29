// Running one statement of a MongoDB query editor (V7.7), free of `vscode`: parse it, see
// what it may change, let the connection's policy and safe mode stop or question it, then
// run it (D90). The editor bits — the question, the session — arrive through the deps.

import { DbError } from '../../core/errors';
import { lineAndColumn } from '../../core/mongo/shell-parse';
import {
  parseShellStatement,
  type ShellStatement,
  ShellSyntaxError,
} from '../../core/mongo/shell-command';
import type { MongoSession } from '../../drivers/mongo-driver';
import type { SafeMode } from '../../services/safe-mode';
import { type RunOutcome, runStatement, statementEffect } from '../../services/mongodb/shell-run';
import type { WritePolicy } from '../../services/write-policy';
import type { TreeNode } from '../tree/nodes';

/** The question before a run: a write on production, or a dangerous one in safe mode. */
export interface MongoRunQuestion {
  readonly kind: 'production' | 'dangerous';
  readonly statement: string;
  /** Also on a production connection, for a dangerous statement. */
  readonly production: boolean;
}

export interface MongoRunDeps {
  readonly session: () => Promise<MongoSession>;
  readonly policy: WritePolicy;
  readonly safeMode: SafeMode;
  readonly maxTimeMS: number;
  /** True when the user lets the statement run. */
  readonly ask: (question: MongoRunQuestion) => Promise<boolean>;
  readonly texts: {
    readonly readOnly: string;
    /** Safe mode in `block` refuses a statement like this. */
    readonly blocked: string;
  };
  readonly now?: () => number;
}

export type MongoRunResult =
  | { readonly kind: 'cancelled' }
  | {
      readonly kind: 'done';
      readonly outcome: RunOutcome;
      /** The database the statement ran in (the editor's, or the one it named). */
      readonly database: string;
      readonly tookMs: number;
    };

/**
 * Parses a statement, saying where it is wrong in the document: `offset` is where the
 * statement starts there, so the line and column point at the editor's text.
 */
export function parseInDocument(
  document: string,
  offset: number,
  statement: string,
): ShellStatement {
  try {
    return parseShellStatement(statement);
  } catch (error) {
    if (error instanceof ShellSyntaxError) {
      const { line, column } = lineAndColumn(document, offset + error.offset);
      throw new DbError('syntax', `${line}:${column} ${error.message}`, {
        position: offset + error.offset,
      });
    }
    throw error;
  }
}

/** Runs a parsed statement after the policy lets it; `cancelled` when the user says no. */
export async function runMongoStatement(
  deps: MongoRunDeps,
  database: string,
  statement: ShellStatement,
  text: string,
): Promise<MongoRunResult> {
  const effect = statementEffect(statement);
  if (effect !== 'read') {
    if (deps.policy.readOnly) {
      throw new DbError('permission-denied', deps.texts.readOnly);
    }
    if (effect === 'dangerous' && deps.safeMode === 'block') {
      throw new DbError('permission-denied', deps.texts.blocked);
    }
    // One question at most: production asks about every change and says when it is
    // dangerous too; elsewhere safe mode asks about the dangerous ones (D52, D87).
    const dangerous = effect === 'dangerous' && deps.safeMode === 'confirm';
    if (deps.policy.production || dangerous) {
      const allowed = await deps.ask({
        kind: dangerous ? 'dangerous' : 'production',
        statement: text,
        production: deps.policy.production,
      });
      if (!allowed) {
        return { kind: 'cancelled' };
      }
    }
  }
  const now = deps.now ?? Date.now;
  const started = now();
  const session = await deps.session();
  const outcome = await runStatement(session, database, statement, { maxTimeMS: deps.maxTimeMS });
  const target = statement.kind === 'call' ? (statement.database ?? database) : database;
  return { kind: 'done', outcome, database: target, tookMs: Math.max(0, now() - started) };
}

/** What a new query starts with, by what it was opened from. */
export function queryTemplate(node: TreeNode | undefined): string {
  if (node?.kind === 'mongoCollection') {
    const name = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(node.collection)
      ? `db.${node.collection}`
      : `db.getCollection(${JSON.stringify(node.collection)})`;
    return node.collectionType === 'view' || node.collectionType === 'timeseries'
      ? `${name}.find({})\n`
      : `${name}.find({})\n\n${name}.aggregate([\n  { $match: {} },\n  { $limit: 20 }\n])\n`;
  }
  return 'show collections\n';
}
