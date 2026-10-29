// Reading a script of any size in parts (V5.1): statements come out as soon as they
// are complete, so a dump of gigabytes never has to sit in memory as one string.
// The state that crosses part boundaries — MySQL's DELIMITER, a string or comment
// still open, PostgreSQL's COPY data — is kept here, not in the caller.

import type { DriverId } from '../../shared/connection';
import { DEFAULT_DELIMITER, splitScript } from './split';
import { syntaxOf, tokenize } from './tokenizer';

export type ScriptItem =
  /** A statement for the server. */
  | { readonly kind: 'statement'; readonly text: string; readonly line: number }
  /** A line for the psql client (`\connect`, `\restrict`), which the server cannot run. */
  | { readonly kind: 'psql-command'; readonly text: string; readonly line: number }
  /**
   * `COPY … FROM stdin`: its data follows in the script, up to a `\.` line, and is
   * skipped here, because the rows travel by a protocol of their own.
   */
  | { readonly kind: 'copy-from-stdin'; readonly text: string; readonly line: number };

export class ScriptReader {
  private buffer = '';
  private delimiter = DEFAULT_DELIMITER;
  /** The line number of `buffer[0]`. */
  private line = 1;
  private copyData = false;
  /** Splitting waits until the buffer is this long; see `afterNoProgress`. */
  private nextSplit = 0;

  constructor(private readonly driver: DriverId | undefined) {}

  /** Adds the next part of the text; returns what became complete. */
  push(text: string): ScriptItem[] {
    this.buffer += text;
    return this.drain(false);
  }

  /** The text has ended: everything left is complete now. */
  end(): ScriptItem[] {
    return this.drain(true);
  }

  private drain(final: boolean): ScriptItem[] {
    const items: ScriptItem[] = [];
    for (;;) {
      if (this.copyData && !this.skipCopyData(final)) {
        return items;
      }
      // Only whole lines are split, so a DELIMITER or psql command is never cut short.
      const limit = final ? this.buffer.length : this.buffer.lastIndexOf('\n') + 1;
      if (limit === 0 || (!final && this.buffer.length < this.nextSplit)) {
        return items;
      }
      const region = this.buffer.slice(0, limit);
      const split = splitScript(region, this.driver, {
        delimiter: this.delimiter,
        psqlCommands: this.driver === 'postgres',
      });
      const pieces = split.pieces;
      // The last piece may still go on in the next part, unless the text has ended.
      const complete = final ? pieces : pieces.slice(0, -1);
      const last = final ? undefined : pieces[pieces.length - 1];
      let cursor = 0;
      let line = this.line;
      let copyAt: number | undefined;
      for (const piece of complete) {
        line += countLines(this.buffer, cursor, piece.start);
        cursor = piece.start;
        const kind =
          piece.kind === 'psql-command'
            ? 'psql-command'
            : this.driver === 'postgres' && isCopyFromStdin(piece.text)
              ? 'copy-from-stdin'
              : 'statement';
        // Leading comments belong to no statement in particular: whether they stay
        // depends on where a part was cut, so the item starts at the code itself.
        const code = codeStart(piece.text, this.driver);
        items.push({
          kind,
          text: piece.text.slice(code),
          line: line + countLines(piece.text, 0, code),
        });
        if (kind === 'copy-from-stdin') {
          // The data starts on the line after the statement's terminator.
          const newline = this.buffer.indexOf('\n', piece.end);
          copyAt = newline === -1 ? this.buffer.length : newline + 1;
          break;
        }
      }
      if (copyAt !== undefined) {
        this.advance(copyAt);
        this.copyData = true;
        this.nextSplit = 0;
        continue;
      }
      if (last === undefined) {
        if (!final && unterminatedAtEnd(region, this.driver)) {
          // Only a comment or string still open: it may hold code-looking text that
          // must stay part of it, so nothing can be dropped yet.
          this.afterNoProgress();
          return items;
        }
        this.advance(limit);
        this.delimiter = split.delimiter;
        this.nextSplit = 0;
        if (final) {
          return items;
        }
        continue;
      }
      this.advance(last.start);
      this.delimiter = last.delimiter;
      if (complete.length === 0) {
        this.afterNoProgress();
      } else {
        this.nextSplit = 0;
      }
      return items;
    }
  }

  /**
   * A statement longer than a part is split again only once the buffer has doubled,
   * so a 100 MB INSERT costs a few passes, not one per part.
   */
  private afterNoProgress(): void {
    this.nextSplit = this.buffer.length * 2;
  }

  /** Drops COPY data up to and including its `\.` line; false when more text is needed. */
  private skipCopyData(final: boolean): boolean {
    let from = 0;
    let lines = 0;
    for (;;) {
      const newline = this.buffer.indexOf('\n', from);
      if (newline === -1) {
        if (!final) {
          this.dropLines(from, lines);
          return false;
        }
        const rest = this.buffer.slice(from).replace(/\r$/u, '');
        this.dropLines(this.buffer.length, lines + (rest === '' ? 0 : 1));
        this.copyData = false;
        return true;
      }
      const text = this.buffer.slice(from, newline).replace(/\r$/u, '');
      from = newline + 1;
      lines += 1;
      if (text === '\\.') {
        this.dropLines(from, lines);
        this.copyData = false;
        return true;
      }
    }
  }

  private dropLines(offset: number, lines: number): void {
    this.buffer = this.buffer.slice(offset);
    this.line += lines;
  }

  private advance(offset: number): void {
    this.line += countLines(this.buffer, 0, offset);
    this.buffer = this.buffer.slice(offset);
  }
}

function countLines(text: string, from: number, to: number): number {
  let count = 0;
  let index = text.indexOf('\n', from);
  while (index !== -1 && index < to) {
    count += 1;
    index = text.indexOf('\n', index + 1);
  }
  return count;
}

/** Offset of the first token that is code; MySQL's `/*!` comments are code too. */
function codeStart(text: string, driver: DriverId | undefined): number {
  const syntax = syntaxOf(driver);
  for (const token of tokenize(text, syntax)) {
    if (token.kind === 'whitespace') {
      continue;
    }
    const executable =
      syntax.executableComments && /^\/\*M?!/u.test(text.slice(token.start, token.start + 4));
    if (token.kind !== 'comment' || executable) {
      return token.start;
    }
  }
  return 0;
}

/** True when the text ends inside a string, comment or quoted name. */
function unterminatedAtEnd(text: string, driver: DriverId | undefined): boolean {
  const tokens = tokenize(text, syntaxOf(driver));
  return tokens[tokens.length - 1]?.unterminated === true;
}

/** `COPY table … FROM STDIN …`, the form pg_dump writes for table data. */
export function isCopyFromStdin(statement: string): boolean {
  const words = tokenize(statement, syntaxOf('postgres'))
    .filter((token) => token.kind === 'word')
    .map((token) => statement.slice(token.start, token.end).toUpperCase());
  if (words[0] !== 'COPY') {
    return false;
  }
  return words.some((word, index) => word === 'FROM' && words[index + 1] === 'STDIN');
}
