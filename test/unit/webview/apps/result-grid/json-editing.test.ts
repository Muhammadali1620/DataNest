import { describe, expect, it } from 'vitest';
import {
  applyKey,
  type EditState,
  XML_PAIRS,
} from '../../../../../webview/src/apps/result-grid/json-editing';

/** `|` marks the caret, `[` and `]` a selection, in the notation of the cases below. */
function at(text: string, start = text.length, end = start): EditState {
  return { text, start, end };
}

describe('pairs', () => {
  it.each([
    ['{', '{}'],
    ['[', '[]'],
    ['"', '""'],
  ])('typing %s adds its closer and keeps the caret between', (key, pair) => {
    expect(applyKey(at(''), key)).toEqual({ text: pair, start: 1, end: 1 });
  });

  it('pairs in the middle of the text', () => {
    expect(applyKey(at('{"a": }', 6), '[')).toEqual({ text: '{"a": []}', start: 7, end: 7 });
  });

  it('wraps a selection and keeps it selected', () => {
    expect(applyKey(at('one two', 4, 7), '"')).toEqual({ text: 'one "two"', start: 5, end: 8 });
    expect(applyKey(at('x', 0, 1), '{')).toEqual({ text: '{x}', start: 1, end: 2 });
  });

  it('does not pair a quote that closes a string or follows a word', () => {
    expect(applyKey(at('"ab', 3), '"')).toBeUndefined();
    expect(applyKey(at('a', 1), '"')).toBeUndefined();
    expect(applyKey(at('\\', 1), '"')).toBeUndefined();
  });

  it('pairs a quote after a colon, a comma, a bracket or a space', () => {
    for (const before of [':', ',', '[', ' ', '{']) {
      expect(applyKey(at(before), '"')?.text).toBe(`${before}""`);
    }
  });
});

describe('stepping over a closer', () => {
  it.each(['}', ']', '"'])('typing %s before the same character moves past it', (key) => {
    expect(applyKey(at(`a${key}`, 1), key)).toEqual({ text: `a${key}`, start: 2, end: 2 });
  });

  it('steps over a quote that was just paired', () => {
    const typed = applyKey(at(''), '"');
    expect(typed).toBeDefined();
    expect(applyKey(typed ?? at(''), '"')).toEqual({ text: '""', start: 2, end: 2 });
  });

  it('leaves a closer alone when something else follows', () => {
    expect(applyKey(at('ab', 1), '}')).toBeUndefined();
  });
});

describe('Backspace', () => {
  it.each(['{}', '[]', '""'])('removes both halves of an empty pair %s', (pair) => {
    expect(applyKey(at(pair, 1), 'Backspace')).toEqual({ text: '', start: 0, end: 0 });
  });

  it('is the browser’s for anything else', () => {
    expect(applyKey(at('{a}', 2), 'Backspace')).toBeUndefined();
    expect(applyKey(at('{', 1), 'Backspace')).toBeUndefined();
    expect(applyKey(at('', 0), 'Backspace')).toBeUndefined();
    expect(applyKey(at('{}', 1, 2), 'Backspace')).toBeUndefined();
  });
});

describe('Enter', () => {
  it('opens a block between brackets with the caret on the indented middle line', () => {
    expect(applyKey(at('{}', 1), 'Enter')).toEqual({ text: '{\n  \n}', start: 4, end: 4 });
    expect(applyKey(at('[]', 1), 'Enter')).toEqual({ text: '[\n  \n]', start: 4, end: 4 });
  });

  it('keeps the indentation of the line it is on', () => {
    expect(applyKey(at('  "a": 1', 9), 'Enter')).toEqual({
      text: '  "a": 1\n  ',
      start: 12,
      end: 12,
    });
  });

  it('indents one level more after an opener', () => {
    expect(applyKey(at('{'), 'Enter')).toEqual({ text: '{\n  ', start: 4, end: 4 });
  });

  it('indents the block between brackets inside an indented line', () => {
    expect(applyKey(at('  "a": []', 8), 'Enter')).toEqual({
      text: '  "a": [\n    \n  ]',
      start: 13,
      end: 13,
    });
  });

  it('keeps the level after a comma', () => {
    expect(applyKey(at('  "a": 1,'), 'Enter')?.text).toBe('  "a": 1,\n  ');
  });

  it('replaces a selection', () => {
    expect(applyKey(at('ab', 0, 2), 'Enter')).toEqual({ text: '\n', start: 1, end: 1 });
  });
});

describe('Tab', () => {
  it('inserts two spaces', () => {
    expect(applyKey(at('ab', 1), 'Tab')).toEqual({ text: 'a  b', start: 3, end: 3 });
  });

  it('takes up to two leading spaces off the line with Shift', () => {
    expect(applyKey(at('    x', 5), 'Tab', true)).toEqual({ text: '  x', start: 3, end: 3 });
    expect(applyKey(at(' x', 2), 'Tab', true)).toEqual({ text: 'x', start: 1, end: 1 });
  });

  it('leaves a line without indentation as it is', () => {
    expect(applyKey(at('x', 1), 'Tab', true)).toEqual({ text: 'x', start: 1, end: 1 });
  });

  it('works on the line the caret is on, not the first', () => {
    expect(applyKey(at('a\n  b', 5), 'Tab', true)).toEqual({ text: 'a\nb', start: 3, end: 3 });
  });
});

describe('other keys', () => {
  it.each(['a', '1', ':', ',', 'ArrowLeft', 'Delete'])('%s is the browser’s own', (key) => {
    expect(applyKey(at('x'), key)).toBeUndefined();
  });
});

describe('markup and parentheses', () => {
  it('pairs a paren in JSON mode and steps over its closer', () => {
    expect(applyKey(at('['), '(')).toEqual({ text: '[()', start: 2, end: 2 });
    expect(applyKey(at('()', 1), ')')).toEqual({ text: '()', start: 2, end: 2 });
  });

  it('pairs tag brackets, quotes and parens in markup', () => {
    expect(applyKey(at(''), '<', false, XML_PAIRS)).toEqual({ text: '<>', start: 1, end: 1 });
    expect(applyKey(at(''), "'", false, XML_PAIRS)).toEqual({ text: "''", start: 1, end: 1 });
    expect(applyKey(at('<a b='), '"', false, XML_PAIRS)).toEqual({
      text: '<a b=""',
      start: 6,
      end: 6,
    });
    expect(applyKey(at(''), '(', false, XML_PAIRS)).toEqual({ text: '()', start: 1, end: 1 });
  });

  it('steps over a closing bracket that was paired', () => {
    expect(applyKey(at('<svg>', 4), '>', false, XML_PAIRS)).toEqual({
      text: '<svg>',
      start: 5,
      end: 5,
    });
  });

  it('leaves a "<" in front of a word alone', () => {
    expect(applyKey(at('a<b', 1), '<', false, XML_PAIRS)).toBeUndefined();
  });

  it('does not pair an apostrophe inside a word', () => {
    expect(applyKey(at('don'), "'", false, XML_PAIRS)).toBeUndefined();
  });

  it('wraps a selection in angle brackets and quotes', () => {
    expect(applyKey(at('tag', 0, 3), '<', false, XML_PAIRS)).toEqual({
      text: '<tag>',
      start: 1,
      end: 4,
    });
    expect(applyKey(at('v', 0, 1), "'", false, XML_PAIRS)?.text).toBe("'v'");
  });

  it('removes an empty tag pair or quote pair with Backspace', () => {
    expect(applyKey(at('<>', 1), 'Backspace', false, XML_PAIRS)).toEqual({
      text: '',
      start: 0,
      end: 0,
    });
    expect(applyKey(at("''", 1), 'Backspace', false, XML_PAIRS)?.text).toBe('');
  });

  it('opens a new indented line between a tag and its closing tag', () => {
    const state = at('<g></g>', 3);
    expect(applyKey(state, 'Enter', false, XML_PAIRS)).toEqual({
      text: '<g>\n  \n</g>',
      start: 6,
      end: 6,
    });
  });

  it('does not expand the empty pair "<>" on Enter', () => {
    expect(applyKey(at('<>', 1), 'Enter', false, XML_PAIRS)?.text).toBe('<\n>');
  });

  it('indents inside a paren pair', () => {
    expect(applyKey(at('()', 1), 'Enter')?.text).toBe('(\n  \n)');
  });
});
