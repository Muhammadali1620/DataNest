// Walking the keys of a database with SCAN (V7.2): a few hundred keys per step, so the
// server is never blocked, and a time budget per load, so a pattern that matches little
// in millions of keys does not keep the tree waiting — the walk resumes where it left off.

import type { RedisSession } from '../../drivers/redis-driver';
import { redisKeyRef } from '../../shared/redis-key';
import type { LoadedKey } from './key-tree';
import { replyText } from './reply';

/** Where a walk stands: the master (0 for a server) and its cursor. */
export interface ScanPosition {
  readonly master: number;
  readonly cursor: string;
  readonly done: boolean;
}

export const SCAN_START: ScanPosition = { master: 0, cursor: '0', done: false };

/** Keys the server looks at per step: enough to move fast, too few to block it. */
export const SCAN_STEP_COUNT = 1000;

export interface ScanRequest {
  /** A glob; all keys when absent. */
  readonly match?: string;
  /** Stop once this many keys were found. */
  readonly want: number;
  /** Stop after this many milliseconds, even with fewer keys. */
  readonly budgetMs: number;
  readonly now?: () => number;
}

export interface ScanResult {
  readonly keys: Uint8Array[];
  readonly position: ScanPosition;
}

/** Steps from `position` until enough keys, the end, or the time budget. */
export async function scanFrom(
  session: RedisSession,
  position: ScanPosition,
  request: ScanRequest,
): Promise<ScanResult> {
  const now = request.now ?? Date.now;
  const started = now();
  const keys: Uint8Array[] = [];
  let { master, cursor, done } = position;
  while (!done && keys.length < request.want) {
    const step = await session.scanStep(master, cursor, {
      ...(request.match === undefined ? {} : { match: request.match }),
      count: SCAN_STEP_COUNT,
    });
    keys.push(...step.keys);
    if (step.cursor === '0') {
      master += 1;
      cursor = '0';
      done = master >= step.masters;
    } else {
      cursor = step.cursor;
    }
    if (now() - started >= request.budgetMs) {
      break;
    }
  }
  return { keys, position: { master, cursor, done } };
}

/** Pipelined TYPE in batches; a key deleted meanwhile (`none`) is left out. */
export async function withTypes(
  session: RedisSession,
  keys: readonly Uint8Array[],
): Promise<LoadedKey[]> {
  const result: LoadedKey[] = [];
  for (let start = 0; start < keys.length; start += SCAN_STEP_COUNT) {
    const batch = keys.slice(start, start + SCAN_STEP_COUNT);
    const types = await session.pipeline(batch.map((key) => ['TYPE', key]));
    batch.forEach((key, index) => {
      const reply = types[index] ?? null;
      const type =
        typeof reply === 'object' && reply !== null && 'error' in reply
          ? undefined
          : replyText(reply);
      if (type !== 'none') {
        result.push({
          key: redisKeyRef(key),
          ...(type === undefined || type === '' ? {} : { type }),
        });
      }
    });
  }
  return result;
}

const GLOB_SPECIAL = /[*?[\]\\]/g;

/** Text as a glob that matches it literally. */
export function escapeGlob(text: string): string {
  return text.replace(GLOB_SPECIAL, (char) => `\\${char}`);
}

/**
 * What "find a key" looks for: a pattern the user wrote as one (`user:*`) is taken as
 * it is; plain text is found anywhere in the name.
 */
export function searchPattern(text: string): string | undefined {
  const trimmed = text.trim();
  if (trimmed === '') {
    return undefined;
  }
  return /[*?[]/.test(trimmed) ? trimmed : `*${escapeGlob(trimmed)}*`;
}

export interface FoundKeys {
  readonly keys: LoadedKey[];
  /** SCAN walked the whole database: there are no more matches than these. */
  readonly complete: boolean;
}

/**
 * Keys whose names match what the user typed (see `searchPattern`), at most `limit`
 * of them, walking no longer than the budget. Nothing typed finds nothing.
 */
export async function findKeys(
  session: RedisSession,
  text: string,
  options: { readonly limit: number; readonly budgetMs: number; readonly now?: () => number },
): Promise<FoundKeys> {
  const match = searchPattern(text);
  if (match === undefined) {
    return { keys: [], complete: true };
  }
  const scanned = await scanFrom(session, SCAN_START, {
    match,
    want: options.limit,
    budgetMs: options.budgetMs,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  // SCAN may return a key twice while the server rehashes.
  const unique = new Map(scanned.keys.map((key) => [Buffer.from(key).toString('hex'), key]));
  const keys = await withTypes(session, [...unique.values()].slice(0, options.limit));
  return { keys, complete: scanned.position.done };
}
