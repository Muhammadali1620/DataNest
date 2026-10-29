// The Redis console (V7.4): one line, one command, as in redis-cli. Before it runs, the
// connection decides (D87): read-only refuses what may write, production asks before a
// write, and safe mode asks (or refuses) before what the server calls dangerous and
// writes — FLUSHALL, FLUSHDB, CONFIG SET, SHUTDOWN — and before KEYS, which blocks a
// big server. The server's own command flags tell which is which (D83).

import { DbError, errorMessage, toDbError } from '../../core/errors';
import { type CommandWord, parseCommandLine } from '../../core/redis/command-line';
import type { RedisSession } from '../../drivers/redis-driver';
import type { SafeMode } from '../safe-mode';
import type { WritePolicy } from '../write-policy';
import {
  type CommandEffect,
  commandEffect,
  commandFor,
  parseCommandInfo,
  type RedisCommandInfo,
} from './command-info';
import { escapeGlob, SCAN_START, scanFrom } from './key-scan';
import { formatReply } from './reply-format';
import { redisKeyRef } from '../../shared/redis-key';

/** Commands that turn the connection into something a console line cannot show. */
const UNSUPPORTED: ReadonlyMap<string, string> = new Map([
  ['subscribe', 'Subscriptions stream messages without end; use redis-cli for them'],
  ['psubscribe', 'Subscriptions stream messages without end; use redis-cli for them'],
  ['ssubscribe', 'Subscriptions stream messages without end; use redis-cli for them'],
  ['monitor', 'MONITOR streams every command without end; use redis-cli for it'],
  ['sync', 'Replication streams are not for a console'],
  ['psync', 'Replication streams are not for a console'],
  ['hello', 'The protocol is set by DataNest; change the connection instead'],
  ['auth', 'The user is set by the connection; edit it instead'],
  ['quit', 'Close the console tab instead'],
  ['reset', 'Close and reopen the console instead'],
]);

/** Reads that can still stop a big server for a long time. */
const HEAVY_READS = new Set(['keys']);

export type ConsoleQuestion =
  | { readonly kind: 'production'; readonly command: string }
  | { readonly kind: 'dangerous'; readonly command: string; readonly production: boolean };

export interface ConsoleDeps {
  /** The console's own session; SELECT in it must not move other views. */
  readonly session: () => Promise<RedisSession>;
  readonly policy: WritePolicy;
  readonly safeMode: () => SafeMode;
  readonly confirm: (question: ConsoleQuestion) => Promise<boolean>;
  /** A SELECT went through: the console now works in this database. */
  readonly onDatabase: (database: number) => void;
  /** Items shown per array of a reply. */
  readonly maxItems?: number;
  readonly now?: () => number;
}

export interface ConsoleResult {
  /** The line as the user wrote it. */
  readonly command: string;
  readonly lines: readonly string[];
  /** The server refused it, or DataNest did. */
  readonly error: boolean;
  /** How long the server took, for commands that ran. */
  readonly ms?: number;
}

const DEFAULT_MAX_ITEMS = 1000;

const UTF8 = new TextDecoder('utf-8');

function wordText(word: CommandWord): string {
  return typeof word === 'string' ? word : UTF8.decode(word);
}

export class RedisConsole {
  /** `COMMAND INFO` per command name, asked once per console. */
  private readonly infos = new Map<string, RedisCommandInfo | undefined>();

  constructor(private readonly deps: ConsoleDeps) {}

  /** Runs one line; undefined for a blank line or a comment. */
  async run(line: string): Promise<ConsoleResult | undefined> {
    const command = line.trim();
    if (command === '' || command.startsWith('#')) {
      return undefined;
    }
    const parsed = parseCommandLine(command);
    if (!parsed.ok) {
      return this.refused(
        command,
        parsed.problem === 'unclosed-quote'
          ? 'A quote is not closed'
          : 'A closing quote must be followed by a space',
      );
    }
    const words = parsed.words;
    const name = wordText(words[0] ?? '').toLowerCase();
    const unsupported = UNSUPPORTED.get(name);
    if (unsupported !== undefined) {
      return this.refused(command, unsupported);
    }
    try {
      const verdict = await this.verdict(name, words.map(wordText));
      if (verdict !== undefined) {
        return this.refused(command, verdict);
      }
      const session = await this.deps.session();
      const now = this.deps.now ?? Date.now;
      const started = now();
      const reply = await session.call(words);
      const ms = now() - started;
      if (name === 'select') {
        this.deps.onDatabase(Number(wordText(words[1] ?? '0')));
      }
      return {
        command,
        lines: formatReply(reply, { maxItems: this.deps.maxItems ?? DEFAULT_MAX_ITEMS }),
        error: false,
        ms,
      };
    } catch (error) {
      const cause = toDbError(error);
      return {
        command,
        lines: [
          `(error) ${errorMessage(cause)}`,
          ...(cause.code === 'connection-failed'
            ? ['(the link is gone: the next command connects again)']
            : []),
        ],
        error: true,
      };
    }
  }

  /** Key names that start with `prefix`, for completion; at most `limit`, found fast. */
  async completeKeys(prefix: string, limit = 50): Promise<string[]> {
    const session = await this.deps.session();
    const found = await scanFrom(session, SCAN_START, {
      match: `${escapeGlob(prefix)}*`,
      want: limit,
      budgetMs: 300,
    });
    return [...new Set(found.keys.map((key) => redisKeyRef(key).text))].slice(0, limit).sort();
  }

  /** Why the command may not run, or undefined when it may (after any question). */
  private async verdict(name: string, words: readonly string[]): Promise<string | undefined> {
    const { policy } = this.deps;
    const safeMode = this.deps.safeMode();
    if (!policy.readOnly && !policy.production && safeMode === 'off') {
      return undefined;
    }
    const info = commandFor(await this.info(name), words);
    const effect: CommandEffect = commandEffect(info);
    if (policy.readOnly && effect !== 'read') {
      return effect === 'unknown'
        ? 'The connection is read-only, and the server does not say what this command does'
        : 'The connection is read-only: this command may change data';
    }
    const dangerous =
      (effect === 'write' && (info?.categories.includes('@dangerous') ?? false)) ||
      HEAVY_READS.has(name);
    const command = words.join(' ');
    if (dangerous && safeMode !== 'off') {
      if (safeMode === 'block') {
        return 'Safe mode blocks this command (datanest.safeMode)';
      }
      const asked = await this.deps.confirm({
        kind: 'dangerous',
        command,
        production: policy.production,
      });
      return asked ? undefined : 'Not run';
    }
    if (policy.production && effect !== 'read') {
      return (await this.deps.confirm({ kind: 'production', command })) ? undefined : 'Not run';
    }
    return undefined;
  }

  private async info(name: string): Promise<RedisCommandInfo | undefined> {
    if (this.infos.has(name)) {
      return this.infos.get(name);
    }
    let info: RedisCommandInfo | undefined;
    try {
      const session = await this.deps.session();
      info = parseCommandInfo(await session.call(['COMMAND', 'INFO', name]))[0];
    } catch (error) {
      if (error instanceof DbError && error.code === 'connection-failed') {
        throw error;
      }
      // An old or restricted server cannot say; the policy treats it as unknown.
      info = undefined;
    }
    this.infos.set(name, info);
    return info;
  }

  private refused(command: string, reason: string): ConsoleResult {
    return { command, lines: [`(refused) ${reason}`], error: true };
  }
}
