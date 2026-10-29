// What the console suggests while the user types (V7.4): every command the server knows,
// with its summary and syntax as the server itself documents them (`COMMAND DOCS`,
// Redis 7+). Older servers list only names (`COMMAND`); either way DataNest ships no
// command reference of its own, so modules and new commands are known too.

import type { RedisReply, RedisSession } from '../../drivers/redis-driver';
import { isErrorReply } from '../../drivers/redis-driver';
import { replyItems, replyText } from './reply';

export interface CommandDoc {
  /** Uppercase, `CONFIG GET` for a subcommand. */
  readonly name: string;
  readonly summary?: string;
  /** The arguments, e.g. `key value [NX | XX] [GET]`. */
  readonly syntax?: string;
  readonly group?: string;
  readonly since?: string;
  /** The first argument is a key, so the console can suggest key names there. */
  readonly keyFirst: boolean;
}

/** A RESP2 map (`[k1, v1, k2, v2]`) as a Map of text keys. */
function asMap(reply: RedisReply | undefined): Map<string, RedisReply> {
  const items = reply === undefined ? [] : replyItems(reply);
  const map = new Map<string, RedisReply>();
  for (let index = 0; index + 1 < items.length; index += 2) {
    map.set(replyText(items[index] ?? null), items[index + 1] ?? null);
  }
  return map;
}

/** One argument as the syntax line writes it. */
function argumentText(argument: RedisReply): string {
  const fields = asMap(argument);
  const type = replyText(fields.get('type') ?? null);
  const flags = replyItems(fields.get('flags') ?? null).map((flag) => replyText(flag));
  const token = fields.has('token') ? replyText(fields.get('token') ?? null) : undefined;
  const display = replyText(fields.get('display_text') ?? fields.get('name') ?? null);
  const children = replyItems(fields.get('arguments') ?? null).map(argumentText);
  let text: string;
  switch (type) {
    case 'pure-token':
      text = token ?? display;
      break;
    case 'oneof':
      text = children.join(' | ');
      break;
    case 'block':
      text = children.join(' ');
      break;
    default:
      text = display;
  }
  if (token !== undefined && type !== 'pure-token') {
    text = `${token} ${text}`;
  }
  if (flags.includes('multiple')) {
    text = `${text} [${text} ...]`;
  }
  if (flags.includes('optional')) {
    return `[${text}]`;
  }
  return type === 'oneof' ? `<${text}>` : text;
}

function docOf(name: string, fields: Map<string, RedisReply>): CommandDoc {
  const args = replyItems(fields.get('arguments') ?? null);
  const first = asMap(args[0]);
  const text = (key: string): string | undefined => {
    const value = fields.get(key);
    return value === undefined || value === null ? undefined : replyText(value);
  };
  const summary = text('summary');
  const group = text('group');
  const since = text('since');
  return {
    name,
    ...(summary === undefined ? {} : { summary }),
    ...(args.length === 0 ? {} : { syntax: args.map(argumentText).join(' ') }),
    ...(group === undefined ? {} : { group }),
    ...(since === undefined ? {} : { since }),
    keyFirst: replyText(first.get('type') ?? null) === 'key',
  };
}

/** Every command and subcommand of a `COMMAND DOCS` reply, sorted by name. */
export function parseCommandDocs(reply: RedisReply): CommandDoc[] {
  const docs: CommandDoc[] = [];
  for (const [name, entry] of asMap(reply)) {
    const fields = asMap(entry);
    docs.push(docOf(name.toUpperCase(), fields));
    for (const [sub, subEntry] of asMap(fields.get('subcommands') ?? null)) {
      // Subcommands are named `config|get`.
      docs.push(docOf(sub.replace('|', ' ').toUpperCase(), asMap(subEntry)));
    }
  }
  return docs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Names from a plain `COMMAND` reply, for servers before 7.0. */
export function parseCommandNames(reply: RedisReply): CommandDoc[] {
  return replyItems(reply)
    .map((entry) => {
      const [name = null, , , firstKey = null] = replyItems(entry);
      return { name: replyText(name).toUpperCase(), keyFirst: replyText(firstKey) === '1' };
    })
    .filter((doc) => doc.name !== '')
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The command catalog of a server; empty when it may not be asked. */
export async function loadCommandDocs(session: RedisSession): Promise<CommandDoc[]> {
  try {
    const reply = await session.call(['COMMAND', 'DOCS']);
    if (!isErrorReply(reply) && replyItems(reply).length > 0) {
      return parseCommandDocs(reply);
    }
  } catch {
    // Before Redis 7 there are no docs; the names still help.
  }
  try {
    return parseCommandNames(await session.call(['COMMAND']));
  } catch {
    // An ACL user without COMMAND: the console works, without suggestions.
    return [];
  }
}
