// Parsing what the user types in the MongoDB shell's syntax (V7.5): a whole value, a
// document (a filter, an index key, options), a pipeline. See shell-reader.ts.

import { ShellReader, ShellSyntaxError } from './shell-reader';
import type { MongoDocument, MongoValue } from './value';
import { msg } from '../user-message';

export { ShellSyntaxError };

/** One value and nothing after it. */
export function parseValue(text: string): MongoValue {
  const reader = new ShellReader(text);
  if (reader.atEnd()) {
    reader.fail(msg('Nothing to read'));
  }
  const value = reader.value();
  if (!reader.atEnd()) {
    reader.fail(msg('Unexpected text after the value{0}', reader.near()));
  }
  return value;
}

/** A document such as `{ status: "new" }`; blank text is the empty document. */
export function parseDocument(text: string, blank: 'empty' | 'error' = 'empty'): MongoDocument {
  if (text.trim() === '' && blank === 'empty') {
    return { type: 'document', fields: [] };
  }
  const value = parseValue(text);
  if (value.type !== 'document') {
    throw new ShellSyntaxError(msg('Expected a document in braces: { … }'), 0);
  }
  return value;
}

/** A pipeline: an array of stage documents; blank text is no stages. */
export function parsePipeline(text: string): MongoDocument[] {
  if (text.trim() === '') {
    return [];
  }
  const value = parseValue(text);
  if (value.type !== 'array') {
    throw new ShellSyntaxError(msg('Expected the stages in brackets: [ { $match: … }, … ]'), 0);
  }
  return value.items.map((stage, index) => {
    if (stage.type !== 'document') {
      throw new ShellSyntaxError(msg('Stage {0} is not a document', index + 1), 0);
    }
    return stage;
  });
}

/** "line 2, column 5" of an offset, for messages. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  const column = offset - (before.lastIndexOf('\n') + 1) + 1;
  return { line, column };
}
