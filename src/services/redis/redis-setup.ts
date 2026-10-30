// What a new Redis session runs before anyone uses it (V7.1): the connection's init
// commands, one per line, as redis-cli reads them (`CLIENT SETNAME app`). Failing here
// fails the connect with the command named, as init SQL does (D55).

import { DbError, errorMessage, toDbError } from '../../core/errors';
import { type CommandWord, parseCommandLine } from '../../core/redis/command-line';
import type { RedisSession } from '../../drivers/redis-driver';
import type { ConnectionInput } from '../../shared/connection';
import { commandEffect, commandFor, parseCommandInfo, SESSION_COMMANDS } from './command-info';
import { msg } from '../../core/user-message';

export interface InitCommand {
  /** The line as written, for messages. */
  readonly line: string;
  readonly words: readonly CommandWord[];
}

const UTF8 = new TextDecoder('utf-8');

function wordText(word: CommandWord): string {
  return typeof word === 'string' ? word : UTF8.decode(word);
}

/**
 * The init commands of a connection, in order. Blank lines and `#` comments are
 * skipped; a line that does not parse, or that would change what the connection is
 * (`SELECT`, `AUTH`, `MULTI`, …), is refused before anything runs.
 */
export function initCommands(config: Pick<ConnectionInput, 'options'>): InitCommand[] {
  const commands: InitCommand[] = [];
  for (const raw of (config.options?.initSql ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const parsed = parseCommandLine(line);
    if (!parsed.ok) {
      throw new DbError(
        'syntax',
        msg('Init command "{0}" is not written correctly: {1}', line, parsed.problem),
      );
    }
    const name = wordText(parsed.words[0] ?? '').toLowerCase();
    if (SESSION_COMMANDS.has(name)) {
      throw new DbError(
        'unsupported',
        msg(
          'Init command "{0}" would change the connection itself; set it in the connection settings',
          line,
        ),
      );
    }
    commands.push({ line, words: parsed.words });
  }
  return commands;
}

/**
 * Runs the init commands on a fresh session. On a read-only connection each one is
 * first checked against the server's command flags: one that may write is refused,
 * and so is one the server cannot describe (V4.6: in doubt, it changes something).
 */
export async function setUpRedisSession(
  session: RedisSession,
  config: Pick<ConnectionInput, 'options' | 'readOnly'>,
): Promise<void> {
  for (const command of initCommands(config)) {
    if (config.readOnly === true) {
      await refuseWrites(session, command);
    }
    try {
      await session.call(command.words);
    } catch (error) {
      const cause = toDbError(error);
      throw new DbError(
        cause.code,
        msg('Init command "{0}" failed: {1}', command.line, errorMessage(cause)),
      );
    }
  }
}

async function refuseWrites(session: RedisSession, command: InitCommand): Promise<void> {
  const words = command.words.map(wordText);
  let info;
  try {
    info = parseCommandInfo(await session.call(['COMMAND', 'INFO', words[0] ?? '']))[0];
  } catch {
    // An old or restricted server cannot say what the command does: treat it as a write.
    info = undefined;
  }
  if (commandEffect(commandFor(info, words)) !== 'read') {
    throw new DbError(
      'permission-denied',
      msg('The init commands of a read-only connection may not change anything: {0}', command.line),
    );
  }
}
