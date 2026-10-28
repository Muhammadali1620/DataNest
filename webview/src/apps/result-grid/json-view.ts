// JSON for the value panel: a lenient tokenizer (so even broken JSON can be shown
// with colour) and a formatter that works on tokens. Formatting must not go through
// JSON.parse/stringify: that would round 12345678901234567890 and drop the
// spelling of every number the database sent.

export type JsonTokenType = 'key' | 'string' | 'number' | 'literal' | 'punct' | 'space' | 'invalid';

export interface JsonToken {
  readonly type: JsonTokenType;
  readonly text: string;
}

const NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const LITERAL = /(?:true|false|null)(?![\w$])/y;
const SPACE = /\s+/y;

function match(pattern: RegExp, text: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0];
}

/** End index (exclusive) of the string that starts at `start`; the text's end if unclosed. */
function stringEnd(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
    } else if (char === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }
  return text.length;
}

/** Splits text into coloured pieces; never throws and always covers the whole text. */
export function tokenizeJson(text: string): JsonToken[] {
  const tokens: JsonToken[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    const space = match(SPACE, text, index);
    if (space !== undefined) {
      tokens.push({ type: 'space', text: space });
      index += space.length;
    } else if (char === '"') {
      const end = stringEnd(text, index);
      const after = match(SPACE, text, end);
      const next = text[end + (after?.length ?? 0)];
      tokens.push({ type: next === ':' ? 'key' : 'string', text: text.slice(index, end) });
      index = end;
    } else if ('{}[],:'.includes(char)) {
      tokens.push({ type: 'punct', text: char });
      index += 1;
    } else {
      const number = match(NUMBER, text, index);
      const literal = number === undefined ? match(LITERAL, text, index) : undefined;
      if (number !== undefined) {
        tokens.push({ type: 'number', text: number });
        index += number.length;
      } else if (literal !== undefined) {
        tokens.push({ type: 'literal', text: literal });
        index += literal.length;
      } else {
        // Anything else up to the next space or structure character is one bad piece.
        let end = index + 1;
        while (end < text.length && !/[\s{}[\],:"]/.test(text[end] ?? '')) {
          end += 1;
        }
        tokens.push({ type: 'invalid', text: text.slice(index, end) });
        index = end;
      }
    }
  }
  return tokens;
}

/** True when the text is one complete JSON value. */
export function isValidJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch (_error) {
    return false;
  }
}

/** True for valid JSON that is an object or array, which is what is worth formatting. */
export function isJsonDocument(text: string): boolean {
  const trimmed = text.trim();
  return (trimmed.startsWith('{') || trimmed.startsWith('[')) && isValidJson(trimmed);
}

function closerOf(opener: string): string {
  return opener === '{' ? '}' : ']';
}

/**
 * Re-indents valid JSON, keeping every string and number exactly as written.
 * Returns undefined for text that is not valid JSON.
 */
export function formatJson(text: string, indent = 2): string | undefined {
  if (!isValidJson(text)) {
    return undefined;
  }
  const tokens = tokenizeJson(text).filter((token) => token.type !== 'space');
  const unit = ' '.repeat(indent);
  let out = '';
  let depth = 0;
  const newline = (): string => `\n${unit.repeat(depth)}`;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === undefined) {
      continue;
    }
    if (token.type !== 'punct') {
      out += token.text;
    } else if (token.text === '{' || token.text === '[') {
      const next = tokens[i + 1];
      if (next?.text === closerOf(token.text)) {
        // An empty object or array stays on one line.
        out += token.text + next.text;
        i += 1;
      } else {
        depth += 1;
        out += token.text + newline();
      }
    } else if (token.text === '}' || token.text === ']') {
      depth -= 1;
      out += newline() + token.text;
    } else if (token.text === ',') {
      out += `,${newline()}`;
    } else {
      out += ': ';
    }
  }
  return out;
}

/** The same JSON with all optional whitespace removed. */
export function minifyJson(text: string): string | undefined {
  if (!isValidJson(text)) {
    return undefined;
  }
  return tokenizeJson(text)
    .filter((token) => token.type !== 'space')
    .map((token) => token.text)
    .join('');
}
