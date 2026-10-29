// What the console page suggests while the user types (V7.4), kept apart from the
// component so it is tested directly: command names (and subcommands after their
// container), the syntax of the command being typed, and where a key name goes.

import type { ConsoleCommandDoc } from '../../../../src/shared/protocols/redis-console';

/** Suggestions shown at most; typing more narrows them. */
export const MAX_SUGGESTIONS = 50;

/** The words of a line up to the caret, and the one being typed (empty after a space). */
export function wordsBefore(text: string): { done: string[]; current: string } {
  const parts = text.split(/\s+/);
  const current = parts.pop() ?? '';
  return { done: parts.filter((part) => part !== ''), current };
}

/** Commands whose name continues what is typed: `GE` → `GET`, `GETDEL`…; `CONFIG G` → `CONFIG GET`. */
export function suggestCommands(
  text: string,
  commands: readonly ConsoleCommandDoc[],
): ConsoleCommandDoc[] {
  const { done, current } = wordsBefore(text);
  if (done.length > 1 || (done.length === 1 && current === '' && !text.endsWith(' '))) {
    return [];
  }
  const typed = [...done, current].join(' ').toUpperCase();
  if (typed === '') {
    return [];
  }
  const level = done.length;
  return commands
    .filter((doc) => doc.name.split(' ').length === level + 1 && doc.name.startsWith(typed))
    .slice(0, MAX_SUGGESTIONS);
}

/** The documented command the line is typing: `CONFIG GET` beats `CONFIG`. */
export function commandOf(
  text: string,
  commands: readonly ConsoleCommandDoc[],
): ConsoleCommandDoc | undefined {
  const words = text
    .trim()
    .split(/\s+/)
    .filter((word) => word !== '')
    .map((word) => word.toUpperCase());
  const byName = new Map(commands.map((doc) => [doc.name, doc]));
  const [first, second] = words;
  if (first === undefined) {
    return undefined;
  }
  return (second === undefined ? undefined : byName.get(`${first} ${second}`)) ?? byName.get(first);
}

/** `SET key value [NX | XX]`: what the hint under the input shows. */
export function syntaxLine(doc: ConsoleCommandDoc): string {
  return doc.syntax === undefined ? doc.name : `${doc.name} ${doc.syntax}`;
}

/**
 * The start of a key name being typed as the first argument of a command that takes a
 * key there, or undefined when no key goes at the caret.
 */
export function keyPrefix(
  text: string,
  commands: readonly ConsoleCommandDoc[],
): string | undefined {
  const { done, current } = wordsBefore(text);
  if (done.length !== 1 || current.startsWith('"') || current.startsWith("'")) {
    return undefined;
  }
  const doc = commands.find((one) => one.name === done[0]?.toUpperCase());
  return doc?.keyFirst === true ? current : undefined;
}

/**
 * The line with the word at the caret replaced, ready for the next word. A subcommand
 * replaces its container too (`CONFIG G` → `CONFIG GET `): `words` says how many words
 * the replacement stands for.
 */
export function complete(text: string, replacement: string, words = 1): string {
  const { done } = wordsBefore(text);
  const kept = done.slice(0, Math.max(0, done.length - (words - 1)));
  return `${[...kept, replacement].join(' ')} `;
}

/** A key name as a console word: quoted when it holds blanks or quotes. */
export function keyWord(name: string): string {
  return /[\s"'\\]/.test(name) || name === ''
    ? `"${name.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
    : name;
}

/** Walks the typed lines with the arrow keys; the line being typed is kept aside. */
export class History {
  private position: number;
  private draft = '';

  constructor(private readonly lines: string[]) {
    this.position = lines.length;
  }

  add(line: string): void {
    if (this.lines.at(-1) !== line) {
      this.lines.push(line);
    }
    this.position = this.lines.length;
    this.draft = '';
  }

  /** The line before, or undefined at the oldest. */
  up(current: string): string | undefined {
    if (this.position === 0) {
      return undefined;
    }
    if (this.position === this.lines.length) {
      this.draft = current;
    }
    this.position -= 1;
    return this.lines[this.position];
  }

  /** The line after, the draft past the newest, or undefined when already there. */
  down(): string | undefined {
    if (this.position >= this.lines.length) {
      return undefined;
    }
    this.position += 1;
    return this.position === this.lines.length ? this.draft : this.lines[this.position];
  }
}
