// Editor-like typing for the value dialog's JSON text box: a bracket or quote closes
// itself with the cursor between, typing the closer steps over it, Enter indents, Tab
// inserts spaces. Pure functions over the text and the selection, so every rule is tested.

export interface EditState {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

const INDENT = '  ';

/** Opener → closer; a quote is its own closer. Each kind of text has its own set. */
export type PairSet = Readonly<Record<string, string>>;

export const JSON_PAIRS: PairSet = { '{': '}', '[': ']', '(': ')', '"': '"' };
/** Markup: tags, attribute quotes and parentheses (in CSS inside `style`). */
export const XML_PAIRS: PairSet = { '<': '>', '(': ')', '"': '"', "'": "'" };

function lineStart(text: string, at: number): number {
  return text.lastIndexOf('\n', at - 1) + 1;
}

function indentOf(text: string, at: number): string {
  const start = lineStart(text, at);
  return /^[ \t]*/u.exec(text.slice(start, at))?.[0] ?? '';
}

function replace(
  state: EditState,
  from: number,
  to: number,
  insert: string,
  caret: number,
): EditState {
  return {
    text: state.text.slice(0, from) + insert + state.text.slice(to),
    start: caret,
    end: caret,
  };
}

/** Whether a quote at the cursor opens a string (rather than closing one or being escaped). */
function opensString(text: string, at: number): boolean {
  const before = text[at - 1];
  return before === undefined || !/[\w"\\]/u.test(before);
}

/**
 * What typing `key` does, or undefined when the browser's own behaviour is right.
 * `shift` matters for Tab only.
 */
export function applyKey(
  state: EditState,
  key: string,
  shift = false,
  pairs: PairSet = JSON_PAIRS,
): EditState | undefined {
  const { text, start, end } = state;
  const selected = start !== end;
  const next = text[end];
  const closers = new Set(Object.values(pairs));

  if (key in pairs) {
    const closer = pairs[key] ?? '';
    if (selected) {
      // A selection is wrapped, and stays selected inside the pair.
      const wrapped = key + text.slice(start, end) + closer;
      return {
        text: text.slice(0, start) + wrapped + text.slice(end),
        start: start + 1,
        end: end + 1,
      };
    }
    if (closer === key) {
      if (next === key) {
        return { text, start: start + 1, end: start + 1 };
      }
      if (!opensString(text, start)) {
        return undefined;
      }
    }
    if (key === '<' && next !== undefined && !/[\s>]/u.test(next)) {
      // A "<" in front of a word is a comparison or a tag being typed before text.
      return undefined;
    }
    return replace(state, start, end, key + closer, start + 1);
  }

  if (closers.has(key) && !selected && next === key) {
    return { text, start: start + 1, end: start + 1 };
  }

  if (key === 'Backspace' && !selected && start > 0) {
    const before = text[start - 1] ?? '';
    if (pairs[before] === next && next !== undefined) {
      return replace(state, start - 1, start + 1, '', start - 1);
    }
    return undefined;
  }

  if (key === 'Enter') {
    const indent = indentOf(text, start);
    const before = text[start - 1];
    const between =
      before !== undefined &&
      next !== undefined &&
      ((pairs[before] === next && !'"\'<'.includes(before)) || (before === '>' && next === '<'));
    if (between) {
      const inner = `\n${indent}${INDENT}`;
      return replace(state, start, end, `${inner}\n${indent}`, start + inner.length);
    }
    const deeper = before === '{' || before === '[' || before === '(' ? INDENT : '';
    const insert = `\n${indent}${deeper}`;
    return replace(state, start, end, insert, start + insert.length);
  }

  if (key === 'Tab') {
    if (shift) {
      const from = lineStart(text, start);
      const lead = /^ {1,2}/u.exec(text.slice(from))?.[0] ?? '';
      if (lead === '') {
        return { text, start, end };
      }
      return {
        text: text.slice(0, from) + text.slice(from + lead.length),
        start: Math.max(from, start - lead.length),
        end: Math.max(from, end - lead.length),
      };
    }
    return replace(state, start, end, INDENT, start + INDENT.length);
  }

  return undefined;
}
