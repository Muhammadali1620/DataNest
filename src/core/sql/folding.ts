// Folding for SQL editors (V10.2.2): each statement that spans lines folds, as do block
// comments, `-- #region` … `-- #endregion` and indented parts of a statement. A folding
// provider turns off the editor's own indentation folding, so it is kept here too.

import type { DriverId } from '../../shared/connection';
import { splitStatements } from './split';
import { isTrivia, syntaxOf, textOf, tokenize } from './tokenizer';

export type FoldKind = 'statement' | 'comment' | 'region' | 'indent';

export interface FoldRange {
  /** Zero-based lines, `end` > `start`. */
  readonly start: number;
  readonly end: number;
  readonly kind: FoldKind;
}

const REGION_START = /^--\s*#region\b/u;
const REGION_END = /^--\s*#endregion\b/u;

/** Offsets of the line starts, so an offset's line is a binary search away. */
function lineStarts(text: string): number[] {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low;
}

/** Leading spaces and tabs of a line; undefined for a blank line. */
function indentOf(line: string): number | undefined {
  const width = line.length - line.trimStart().length;
  return width === line.length ? undefined : width;
}

/** A line followed by deeper lines folds down to the last of them. */
function indentFolds(lines: readonly string[], first: number, last: number): FoldRange[] {
  const folds: FoldRange[] = [];
  for (let line = first; line < last; line++) {
    const indent = indentOf(lines[line] ?? '');
    if (indent === undefined) {
      continue;
    }
    let end = line;
    for (let next = line + 1; next <= last; next++) {
      const deeper = indentOf(lines[next] ?? '');
      if (deeper === undefined) {
        continue;
      }
      if (deeper <= indent) {
        break;
      }
      end = next;
    }
    if (end > line) {
      folds.push({ start: line, end, kind: 'indent' });
    }
  }
  return folds;
}

export function foldingRanges(text: string, driver?: DriverId): FoldRange[] {
  const starts = lineStarts(text);
  const lines = text.split('\n');
  const folds: FoldRange[] = [];
  const regions: number[] = [];
  /** Where code starts, so a statement folds from its first word, not from a comment. */
  const code: number[] = [];
  for (const token of tokenize(text, syntaxOf(driver))) {
    if (token.kind !== 'comment') {
      if (!isTrivia(token)) {
        code.push(token.start);
      }
      continue;
    }
    const comment = textOf(text, token);
    const start = lineOf(starts, token.start);
    if (comment.startsWith('--')) {
      if (REGION_START.test(comment)) {
        regions.push(start);
      } else if (REGION_END.test(comment)) {
        const open = regions.pop();
        if (open !== undefined && start > open) {
          folds.push({ start: open, end: start, kind: 'region' });
        }
      }
      continue;
    }
    // A comment's last line holds its `*/`; the fold keeps that line visible.
    const end = lineOf(starts, Math.max(token.start, token.end - 1));
    if (end > start) {
      folds.push({ start, end, kind: 'comment' });
    }
  }
  let next = 0;
  for (const statement of splitStatements(text, driver)) {
    while (next < code.length && (code[next] ?? 0) < statement.start) {
      next++;
    }
    const first = Math.min(code[next] ?? statement.start, statement.end);
    const start = lineOf(starts, Math.max(statement.start, first));
    const end = lineOf(starts, Math.max(statement.start, statement.end - 1));
    if (end <= start) {
      continue;
    }
    folds.push({ start, end, kind: 'statement' });
    for (const fold of indentFolds(lines, start, end)) {
      if (fold.start !== start || fold.end !== end) {
        folds.push(fold);
      }
    }
  }
  return folds.sort((a, b) => a.start - b.start || b.end - a.end);
}
