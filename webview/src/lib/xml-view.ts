// Colour for markup (SVG, XML, HTML) in an editing box: a lenient tokenizer that never
// throws and always covers the whole text, so half-typed markup is coloured too.

export type XmlTokenType =
  'tag' | 'attr' | 'string' | 'punct' | 'comment' | 'decl' | 'text' | 'invalid';

export interface XmlToken {
  readonly type: XmlTokenType;
  readonly text: string;
}

const NAME_START = /[A-Za-z_:]/u;
const ATTR_NAME = /[^\s=/>"'<]+/y;
const TAG_NAME = /[^\s/>"'<=]+/y;
const SPACE = /\s+/y;

function match(pattern: RegExp, text: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(text)?.[0];
}

/** End (exclusive) of the quoted value that opens at `start`; the end of text if unclosed. */
function quotedEnd(text: string, start: number): number {
  const close = text.indexOf(text[start] ?? '"', start + 1);
  return close === -1 ? text.length : close + 1;
}

export function tokenizeXml(text: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  const push = (type: XmlTokenType, from: number, to: number): void => {
    if (to > from) {
      tokens.push({ type, text: text.slice(from, to) });
    }
  };
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('<!--', index)) {
      const close = text.indexOf('-->', index + 4);
      const end = close === -1 ? text.length : close + 3;
      push('comment', index, end);
      index = end;
    } else if (text.startsWith('<?', index) || text.startsWith('<!', index)) {
      const close = text.indexOf('>', index);
      const end = close === -1 ? text.length : close + 1;
      push('decl', index, end);
      index = end;
    } else if (
      text.startsWith('</', index) ||
      (text[index] === '<' && NAME_START.test(text[index + 1] ?? ''))
    ) {
      const open = text.startsWith('</', index) ? 2 : 1;
      push('punct', index, index + open);
      index += open;
      const name = match(TAG_NAME, text, index);
      if (name !== undefined) {
        push('tag', index, index + name.length);
        index += name.length;
      }
      // Inside the tag: attributes, until its closing ">".
      while (index < text.length) {
        const space = match(SPACE, text, index);
        if (space !== undefined) {
          push('text', index, index + space.length);
          index += space.length;
        } else if (text.startsWith('/>', index)) {
          push('punct', index, index + 2);
          index += 2;
          break;
        } else if (text[index] === '>') {
          push('punct', index, index + 1);
          index += 1;
          break;
        } else if (text[index] === '=') {
          push('punct', index, index + 1);
          index += 1;
        } else if (text[index] === '"' || text[index] === "'") {
          const end = quotedEnd(text, index);
          push('string', index, end);
          index = end;
        } else if (text[index] === '<') {
          // A new tag starts before this one was closed.
          break;
        } else {
          const attr = match(ATTR_NAME, text, index);
          if (attr === undefined) {
            push('invalid', index, index + 1);
            index += 1;
          } else {
            push('attr', index, index + attr.length);
            index += attr.length;
          }
        }
      }
    } else {
      let end = index + 1;
      while (end < text.length && text[end] !== '<') {
        end += 1;
      }
      push('text', index, end);
      index = end;
    }
  }
  return tokens;
}

/** True for text that looks like markup: it starts with a tag, a comment or a declaration. */
export function looksLikeMarkup(text: string): boolean {
  return /^\s*<[!?/A-Za-z]/u.test(text);
}
