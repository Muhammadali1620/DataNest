// Splits a MongoDB query document into statements (V7.7), the way the shell reads them:
// `;` ends one, and so does a line break outside brackets, unless the next line goes on
// with `.` (`db.orders.find()\n  .sort({ a: 1 })`). Strings, comments and regular
// expressions are skipped whole, so a `;` or a bracket inside them changes nothing.

export interface ShellStatementText {
  readonly text: string;
  /** Offsets of the statement in the document, its end excluded. */
  readonly start: number;
  readonly end: number;
}

/** Characters after which a `/` starts a regular expression rather than dividing. */
const BEFORE_REGEX = new Set(['', '(', ',', ':', '[', '{', '=', '!', '&', '|', '?', ';']);

/** Skips a quoted string from its opening quote; returns the offset after it. */
function skipString(text: string, at: number): number {
  const quote = text[at];
  let index = at + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote || (quote !== '`' && char === '\n')) {
      return index + 1;
    }
    index += 1;
  }
  return index;
}

function skipRegex(text: string, at: number): number {
  let index = at + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '\n') {
      return index;
    }
    if (char === '[') {
      inClass = true;
    } else if (char === ']') {
      inClass = false;
    } else if (char === '/' && !inClass) {
      index += 1;
      while (/[a-z]/i.test(text[index] ?? '')) {
        index += 1;
      }
      return index;
    }
    index += 1;
  }
  return index;
}

/** The offset of the next character that is not a space or a comment, from `at` on. */
function significantOffset(text: string, at: number): number {
  let index = at;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (/\s/.test(char)) {
      index += 1;
    } else if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end + 1;
    } else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
    } else {
      return index;
    }
  }
  return text.length;
}

/** The next character that is not a space or a comment, from `at` on. */
function nextSignificant(text: string, at: number): string {
  return text[significantOffset(text, at)] ?? '';
}

/** True when the text holds nothing but spaces and comments. */
function isBlank(text: string): boolean {
  return nextSignificant(text, 0) === '';
}

export function splitShellStatements(text: string): ShellStatementText[] {
  const statements: ShellStatementText[] = [];
  let start = 0;
  let depth = 0;
  /** The last character that was not a space or inside a comment. */
  let last = '';
  const push = (end: number): void => {
    const piece = text.slice(start, end);
    if (!isBlank(piece)) {
      // The statement starts at its code, after the comments above it, so offsets (and
      // the CodeLens) point at code.
      const from = significantOffset(text, start);
      const trail = piece.length - piece.trimEnd().length;
      statements.push({ text: text.slice(from, end - trail), start: from, end: end - trail });
    }
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '"' || char === "'" || char === '`') {
      index = skipString(text, index);
      last = char;
      continue;
    }
    if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === '/' && BEFORE_REGEX.has(last)) {
      index = skipRegex(text, index);
      last = '/';
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      depth += 1;
    } else if (char === ')' || char === ']' || char === '}') {
      depth = Math.max(0, depth - 1);
    } else if (char === ';' && depth === 0) {
      push(index);
      start = index + 1;
      last = '';
      index += 1;
      continue;
    } else if (char === '\n' && depth === 0 && last !== '' && last !== '.' && last !== ',') {
      // A line break ends the statement, unless the next line goes on with `.`.
      if (nextSignificant(text, index + 1) !== '.') {
        push(index);
        start = index + 1;
        last = '';
      }
      index += 1;
      continue;
    }
    if (!/\s/.test(char)) {
      last = char;
    }
    index += 1;
  }
  push(text.length);
  return statements;
}

/** The statement at an offset (a cursor), or the nearest one before it on a blank line. */
export function statementAt(text: string, offset: number): ShellStatementText | undefined {
  const statements = splitShellStatements(text);
  const inside = statements.find(
    (statement) => offset >= statement.start && offset <= statement.end,
  );
  if (inside !== undefined) {
    return inside;
  }
  return [...statements].reverse().find((statement) => statement.end <= offset);
}
