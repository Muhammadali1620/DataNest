// Pure helpers of the MongoDB documents page (V7.6): the pager's words, sorting by a
// column, where a typed text is wrong. Kept apart from the component and tested directly.

import type { TypedProblem } from '../../../../src/shared/protocols/mongo-documents';

/** A field name as the shell writes it: bare when it can be, quoted otherwise. */
export function fieldName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/**
 * The sort a click on a column header asks for: ascending first, descending on the next
 * click on the same column, and back to ascending after that.
 */
export function nextSort(current: string, column: string): string {
  const name = fieldName(column);
  const ascending = `{ ${name}: 1 }`;
  return current.replace(/\s+/g, ' ').trim() === ascending ? `{ ${name}: -1 }` : ascending;
}

/** The direction the sort box gives a column, for the arrow in its header. */
export function sortOf(sort: string, column: string): 'asc' | 'desc' | undefined {
  const name = fieldName(column);
  const plain = sort.replace(/\s+/g, ' ').trim();
  if (plain === `{ ${name}: 1 }`) {
    return 'asc';
  }
  return plain === `{ ${name}: -1 }` ? 'desc' : undefined;
}

/** "line 2, column 5: …" when the problem says where. */
export function problemText(problem: TypedProblem): string {
  return problem.line === undefined || problem.column === undefined
    ? problem.message
    : `${problem.line}:${problem.column} ${problem.message}`;
}

/** The numbers of the pager: "51–100", from the skip and the rows of the page. */
export function rangeOf(skip: number, rows: number): { from: number; to: number } {
  return rows === 0 ? { from: 0, to: 0 } : { from: skip + 1, to: skip + rows };
}

/** Where the previous page starts; never before the first document. */
export function previousSkip(skip: number, limit: number): number {
  return Math.max(0, skip - limit);
}

/** A count as people read it: `1 234 567`, from decimal text of any size. */
export function groupDigits(count: string, separator = ' '): string {
  return count.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** A CSS class per BSON type, so numbers, strings and ids look apart. */
export function cellClass(type: string): string {
  switch (type) {
    case 'int32':
    case 'int64':
    case 'double':
    case 'decimal':
      return 'number';
    case 'string':
    case 'symbol':
      return 'string';
    case 'null':
    case 'undefined':
      return 'null';
    case 'bool':
      return 'bool';
    case 'objectId':
    case 'binary':
      return 'id';
    case 'date':
    case 'timestamp':
      return 'date';
    case 'document':
    case 'array':
      return 'nested';
    default:
      return 'other';
  }
}

/** What a new document starts as in the editor. */
export const NEW_DOCUMENT = '{\n  \n}';
