import { msg } from '../../core/user-message';
// Reading CSV in parts (V5.3), the way RFC 4180 writes it and the way spreadsheets
// actually do: quoted fields may hold delimiters, quotes ("") and line breaks, and
// a part may end anywhere, even between the two characters of "" or CR LF.

/** One record and the line of the file where it starts, from 1. */
export interface CsvRecord {
  readonly line: number;
  readonly fields: string[];
}

/** Delimiters a CSV file commonly uses; the first is the default. */
export const CSV_DELIMITERS = [',', ';', '\t', '|'] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

export class CsvParser {
  private readonly records: CsvRecord[] = [];
  private fields: string[] = [];
  private field = '';
  private quoted = false;
  /** A quote was seen inside a quoted field: either "" or the closing one. */
  private quoteSeen = false;
  /** The field was quoted and has closed; text up to the delimiter is kept as is. */
  private closed = false;
  /** A CR ended the last record; a LF right after belongs to it. */
  private afterCr = false;
  private line = 1;
  private recordLine = 1;
  /** True once anything of the current record has been read. */
  private started = false;

  constructor(private readonly delimiter = ',') {
    if (delimiter.length !== 1 || delimiter === '"' || delimiter === '\n' || delimiter === '\r') {
      throw new Error(msg('A CSV delimiter is one character other than a quote or line break'));
    }
  }

  /** Reads the next part; returns the records it completed. */
  push(text: string): CsvRecord[] {
    for (const char of text) {
      this.read(char);
    }
    return this.records.splice(0);
  }

  /** The text has ended: the last record is complete even without a line break. */
  end(): CsvRecord[] {
    if (this.quoteSeen) {
      this.quoteSeen = false;
      this.quoted = false;
      this.closed = true;
    }
    if (this.started) {
      this.finishRecord();
    }
    return this.records.splice(0);
  }

  private read(char: string): void {
    if (this.afterCr) {
      this.afterCr = false;
      if (char === '\n') {
        return;
      }
    }
    if (this.quoted) {
      if (this.quoteSeen) {
        this.quoteSeen = false;
        if (char === '"') {
          this.field += '"';
          return;
        }
        // The quote before this character closed the field.
        this.quoted = false;
        this.closed = true;
      } else {
        if (char === '"') {
          this.quoteSeen = true;
        } else {
          if (char === '\n') {
            this.line += 1;
          }
          this.field += char;
        }
        return;
      }
    }
    if (char === this.delimiter) {
      this.started = true;
      this.fields.push(this.field);
      this.field = '';
      this.closed = false;
      return;
    }
    if (char === '\n' || char === '\r') {
      if (this.started) {
        this.finishRecord();
      }
      this.afterCr = char === '\r';
      this.line += 1;
      this.recordLine = this.line;
      return;
    }
    if (char === '"' && this.field === '' && !this.closed) {
      this.started = true;
      this.quoted = true;
      return;
    }
    this.started = true;
    this.field += char;
  }

  private finishRecord(): void {
    this.fields.push(this.field);
    this.records.push({ line: this.recordLine, fields: this.fields });
    this.fields = [];
    this.field = '';
    this.closed = false;
    this.started = false;
  }
}

/** Reads a whole text at once. */
export function parseCsv(text: string, delimiter = ','): CsvRecord[] {
  const parser = new CsvParser(delimiter);
  return [...parser.push(text), ...parser.end()];
}

export interface CsvGuess {
  readonly delimiter: CsvDelimiter;
  /** The first record looks like column names rather than data. */
  readonly header: boolean;
}

/**
 * Guesses the delimiter and the header from the start of a file: the delimiter that
 * splits the first records into the same number of fields (more than one) wins.
 */
export function guessCsv(sample: string): CsvGuess {
  // The last line may be cut short; it is left out of the guess.
  const cut = sample.lastIndexOf('\n');
  const text = cut > 0 ? sample.slice(0, cut) : sample;
  let best: { delimiter: CsvDelimiter; score: number; records: CsvRecord[] } = {
    delimiter: ',',
    score: -1,
    records: parseCsv(text, ','),
  };
  for (const delimiter of CSV_DELIMITERS) {
    const records = parseCsv(text, delimiter).slice(0, 50);
    const widths = records.map((record) => record.fields.length);
    const first = widths[0] ?? 0;
    if (first < 2) {
      continue;
    }
    const steady = widths.filter((width) => width === first).length / widths.length;
    const score = steady * 1000 + first;
    if (score > best.score) {
      best = { delimiter, score, records };
    }
  }
  return { delimiter: best.delimiter, header: looksLikeHeader(best.records) };
}

const NUMBERISH = /^[+-]?(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?$/u;

/**
 * Column names are filled in, unique and not numbers. A first row of plain words is
 * names far more often than data, so that is the answer when nothing says otherwise.
 */
function looksLikeHeader(records: readonly CsvRecord[]): boolean {
  const names = records[0]?.fields.map((field) => field.trim()) ?? [];
  if (names.some((name) => name === '' || NUMBERISH.test(name))) {
    return false;
  }
  return new Set(names.map((name) => name.toLowerCase())).size === names.length;
}
