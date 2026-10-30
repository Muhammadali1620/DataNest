import { msg } from '../../core/user-message';
// Reading JSON records in parts (V5.3): a top-level array of objects, or objects one
// after another (JSON Lines). Only one record's text is held at a time, and numbers
// keep the digits of the file, so a 20-digit id or 0.10 is not turned into a double.

/** A value of a record: text, a number as written, true/false, null, or nested JSON. */
export type JsonField =
  string | boolean | null | { readonly number: string } | { readonly json: string };

export type JsonRecord =
  | { readonly line: number; readonly ok: true; readonly fields: ReadonlyMap<string, JsonField> }
  | { readonly line: number; readonly ok: false; readonly error: string };

export class JsonRecordParser {
  private readonly records: JsonRecord[] = [];
  /** Text of the record being read; empty between records. */
  private text = '';
  private depth = 0;
  private inString = false;
  private escaped = false;
  /** A top-level value that is not an object or array: it ends at a separator. */
  private scalar = false;
  /** Set by the first character: inside one top-level array, or records in a row. */
  private mode: 'array' | 'lines' | undefined;
  private arrayClosed = false;
  private line = 1;
  private recordLine = 1;

  push(chunk: string): JsonRecord[] {
    for (const char of chunk) {
      this.read(char);
      if (char === '\n') {
        this.line += 1;
      }
    }
    return this.records.splice(0);
  }

  end(): JsonRecord[] {
    if (this.scalar) {
      this.finish();
    } else if (this.text !== '') {
      this.fail(msg('The file ends inside a record'));
    } else if (this.mode === 'array' && !this.arrayClosed) {
      this.recordLine = this.line;
      this.fail(msg('The array is never closed'));
    }
    return this.records.splice(0);
  }

  private read(char: string): void {
    const blank = /\s/u.test(char);
    if (this.mode === undefined) {
      if (blank) {
        return;
      }
      this.mode = char === '[' ? 'array' : 'lines';
      if (this.mode === 'array') {
        return;
      }
    }
    if (this.text === '' || this.scalar) {
      // Between records, or at the end of a bare top-level value.
      const separator = blank || (this.mode === 'array' && (char === ',' || char === ']'));
      if (this.scalar && separator) {
        this.finish();
      }
      if (separator) {
        if (this.mode === 'array' && char === ']') {
          this.arrayClosed = true;
        }
        return;
      }
      if (this.text === '') {
        if (this.arrayClosed) {
          this.recordLine = this.line;
          this.fail(msg('Text after the end of the array'));
          this.arrayClosed = false;
          this.mode = 'lines';
        }
        this.recordLine = this.line;
        this.scalar = char !== '{' && char !== '[' && char !== '"';
      }
    }
    this.text += char;
    if (this.inString) {
      if (this.escaped) {
        this.escaped = false;
      } else if (char === '\\') {
        this.escaped = true;
      } else if (char === '"') {
        this.inString = false;
        if (this.depth === 0) {
          this.finish();
        }
      }
      return;
    }
    if (char === '"') {
      this.inString = true;
    } else if (char === '{' || char === '[') {
      this.depth += 1;
    } else if ((char === '}' || char === ']') && this.depth > 0) {
      this.depth -= 1;
      if (this.depth === 0) {
        this.finish();
      }
    }
  }

  private finish(): void {
    const text = this.text;
    this.text = '';
    this.scalar = false;
    const fields = parseRecord(text);
    this.records.push(
      typeof fields === 'string'
        ? { line: this.recordLine, ok: false, error: fields }
        : { line: this.recordLine, ok: true, fields },
    );
  }

  private fail(error: string): void {
    this.text = '';
    this.scalar = false;
    this.depth = 0;
    this.inString = false;
    this.records.push({ line: this.recordLine, ok: false, error });
  }
}

const NUMBER_TEXT = Symbol('number text');

/** The fields of one object, or why it is not one. */
export function parseRecord(text: string): ReadonlyMap<string, JsonField> | string {
  let value: unknown;
  try {
    value = JSON.parse(text, keepNumberText);
  } catch (error) {
    return error instanceof Error ? error.message : msg('Not valid JSON');
  }
  // A bare number arrives wrapped by the reviver, which makes it look like an object.
  if (typeof value !== 'object' || value === null || Array.isArray(value) || NUMBER_TEXT in value) {
    return msg('A record must be an object');
  }
  const fields = new Map<string, JsonField>();
  for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
    fields.set(key, toField(field));
  }
  return fields;
}

/** Marks a number with the text it was written as; JSON.parse gives that to a reviver. */
function keepNumberText(_key: string, value: unknown, context?: { source?: string }): unknown {
  if (typeof value === 'number') {
    return { [NUMBER_TEXT]: context?.source ?? String(value) };
  }
  return value;
}

function toField(value: unknown): JsonField {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'object' && NUMBER_TEXT in value) {
    return { number: String((value as Record<symbol, unknown>)[NUMBER_TEXT]) };
  }
  return { json: JSON.stringify(value, (_key, inner: unknown) => plain(inner)) };
}

/** Nested values are written back as JSON, numbers as the file had them. */
function plain(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && NUMBER_TEXT in value) {
    return (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(
      String((value as Record<symbol, unknown>)[NUMBER_TEXT]),
    );
  }
  return value;
}
