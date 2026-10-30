// Just enough XML to read a SQL Server showplan (V8.2): elements and attributes,
// entities, comments and declarations skipped, text ignored. Not a general parser:
// no DTDs, no namespaces beyond dropping the prefix.

import { DbError } from '../../core/errors';

export interface XmlElement {
  /** The name without a namespace prefix. */
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
}

interface OpenElement {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlElement[];
}

const ATTRIBUTE = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/gu;

export function parseXml(text: string): XmlElement {
  const stack: OpenElement[] = [];
  let root: XmlElement | undefined;
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('<', at);
    if (open < 0) {
      break;
    }
    if (text.startsWith('<!--', open)) {
      at = after(text, '-->', open);
      continue;
    }
    if (text.startsWith('<![CDATA[', open)) {
      at = after(text, ']]>', open);
      continue;
    }
    if (text.startsWith('<?', open)) {
      at = after(text, '?>', open);
      continue;
    }
    if (text.startsWith('<!', open)) {
      at = after(text, '>', open);
      continue;
    }
    const close = tagEnd(text, open);
    const body = text.slice(open + 1, close);
    at = close + 1;
    if (body.startsWith('/')) {
      const name = localName(body.slice(1).trim());
      const element = stack.pop();
      if (element?.name !== name) {
        throw new DbError('internal', `The plan XML closes <${name}> that is not open`);
      }
      const finished: XmlElement = element;
      if (stack.length === 0) {
        root ??= finished;
      } else {
        stack.at(-1)?.children.push(finished);
      }
      continue;
    }
    const selfClosing = body.endsWith('/');
    const inner = selfClosing ? body.slice(0, -1) : body;
    const nameEnd = inner.search(/[\s/]|$/u);
    const element: OpenElement = {
      name: localName(inner.slice(0, nameEnd)),
      attributes: attributesOf(inner.slice(nameEnd)),
      children: [],
    };
    if (selfClosing) {
      if (stack.length === 0) {
        root ??= element;
      } else {
        stack.at(-1)?.children.push(element);
      }
    } else {
      stack.push(element);
    }
  }
  if (stack.length > 0 || root === undefined) {
    throw new DbError('internal', 'The plan XML is incomplete');
  }
  return root;
}

/** Child elements with this name, at any depth, not looking inside the matches. */
export function findAll(element: XmlElement, name: string, stopAt?: string): XmlElement[] {
  const found: XmlElement[] = [];
  const walk = (current: XmlElement): void => {
    for (const child of current.children) {
      if (child.name === name) {
        found.push(child);
      } else if (child.name !== stopAt) {
        walk(child);
      }
    }
  };
  walk(element);
  return found;
}

export function findFirst(
  element: XmlElement,
  name: string,
  stopAt?: string,
): XmlElement | undefined {
  for (const child of element.children) {
    if (child.name === name) {
      return child;
    }
    if (child.name !== stopAt) {
      const deeper = findFirst(child, name, stopAt);
      if (deeper !== undefined) {
        return deeper;
      }
    }
  }
  return undefined;
}

function after(text: string, end: string, from: number): number {
  const index = text.indexOf(end, from);
  if (index < 0) {
    throw new DbError('internal', 'The plan XML is incomplete');
  }
  return index + end.length;
}

/** The `>` that ends a tag, skipping any inside quoted attribute values. */
function tagEnd(text: string, open: number): number {
  let quote: string | undefined;
  for (let index = open + 1; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return index;
    }
  }
  throw new DbError('internal', 'The plan XML is incomplete');
}

function localName(name: string): string {
  const colon = name.indexOf(':');
  return colon < 0 ? name : name.slice(colon + 1);
}

function attributesOf(text: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of text.matchAll(ATTRIBUTE)) {
    const name = match[1];
    if (name !== undefined && !name.startsWith('xmlns')) {
      attributes[localName(name)] = decode(match[3] ?? match[4] ?? '');
    }
  }
  return attributes;
}

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/giu, (all, entity: string) => {
    switch (entity.toLowerCase()) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code =
          entity.startsWith('#x') || entity.startsWith('#X')
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : all;
      }
    }
  });
}
