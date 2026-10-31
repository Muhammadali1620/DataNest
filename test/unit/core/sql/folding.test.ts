import { describe, expect, it } from 'vitest';
import { foldingRanges, type FoldRange } from '../../../../src/core/sql/folding';

function of(kind: FoldRange['kind'], text: string): [number, number][] {
  return foldingRanges(text)
    .filter((fold) => fold.kind === kind)
    .map((fold) => [fold.start, fold.end]);
}

describe('foldingRanges', () => {
  it('folds each statement that spans lines, from its first line to its last', () => {
    const text = ['SELECT 1;', 'SELECT a,', '  b', 'FROM t;', '', 'UPDATE t', 'SET a = 1;'].join(
      '\n',
    );
    expect(of('statement', text)).toEqual([
      [1, 3],
      [5, 6],
    ]);
  });

  it('does not fold a statement on one line, or nothing at all', () => {
    expect(foldingRanges('SELECT 1; SELECT 2;')).toEqual([]);
    expect(foldingRanges('')).toEqual([]);
    expect(foldingRanges('\n\n\n')).toEqual([]);
  });

  it('folds block comments that span lines, keeping their closing line', () => {
    const text = ['/* one', '   two', '*/', 'SELECT 1; /* short */'].join('\n');
    expect(of('comment', text)).toEqual([[0, 2]]);
  });

  it('folds -- #region … -- #endregion, nested too', () => {
    const text = [
      '-- #region setup',
      'SELECT 1;',
      '--#region inner',
      'SELECT 2;',
      '-- #endregion',
      '-- #endregion setup',
    ].join('\n');
    expect(of('region', text)).toEqual([
      [0, 5],
      [2, 4],
    ]);
  });

  it('ignores an end without a start, and a start without an end', () => {
    expect(of('region', '-- #endregion\nSELECT 1;\n-- #region open\nSELECT 2;')).toEqual([]);
  });

  it('does not read markers in strings or ordinary comments', () => {
    const text = "SELECT '-- #region'\n-- region\n-- #regionx\n-- #endregion";
    expect(of('region', text)).toEqual([]);
  });

  it('folds indented parts inside a statement', () => {
    const text = [
      'SELECT *',
      'FROM orders',
      'WHERE id IN (',
      '    SELECT order_id',
      '    FROM items',
      '',
      '    WHERE qty > 1',
      ')',
      'ORDER BY id;',
    ].join('\n');
    expect(of('indent', text)).toEqual([[2, 6]]);
    expect(of('statement', text)).toEqual([[0, 8]]);
  });

  it('nests indented folds and skips one that repeats the statement', () => {
    const text = ['CREATE TABLE t (', '  a int,', '  b int', ')'].join('\n');
    // The indented block from line 0 ends at 2, short of the statement's last line.
    expect(of('indent', text)).toEqual([[0, 2]]);
    const whole = ['SELECT', '  a,', '  b'].join('\n');
    expect(of('statement', whole)).toEqual([[0, 2]]);
    expect(of('indent', whole)).toEqual([]);
    const nested = ['SELECT', '  a', '    b', '  c', 'FROM t'].join('\n');
    expect(of('indent', nested)).toEqual([
      [0, 3],
      [1, 2],
    ]);
  });

  it('orders folds by start, outer before inner', () => {
    const text = ['-- #region', 'SELECT a,', '  b', 'FROM t;', '-- #endregion'].join('\n');
    expect(foldingRanges(text).map((fold) => [fold.kind, fold.start, fold.end])).toEqual([
      ['region', 0, 4],
      ['statement', 1, 3],
      ['indent', 1, 2],
    ]);
  });

  it('folds a statement from its first word, not from the comment above it', () => {
    const text = '-- what it does\n-- and why\nSELECT 1,\n2;';
    expect(of('statement', text)).toEqual([[2, 3]]);
    expect(of('statement', '/* a\nnote */ SELECT 1,\n2;')).toEqual([[1, 2]]);
  });

  it('reads the comments of the dialect', () => {
    // In MySQL `#` starts a comment; elsewhere it is code, and the statement starts there.
    const text = '# a\nSELECT 1,\n2;';
    expect(foldingRanges(text, 'mysql')).toEqual([{ start: 1, end: 2, kind: 'statement' }]);
    expect(foldingRanges(text, 'postgres').filter((fold) => fold.kind === 'statement')).toEqual([
      { start: 0, end: 2, kind: 'statement' },
    ]);
  });

  it('copes with an unterminated comment and Windows line ends', () => {
    expect(of('comment', '/* never\nclosed')).toEqual([[0, 1]]);
    expect(of('statement', 'SELECT 1,\r\n2;\r\n')).toEqual([[0, 1]]);
  });
});
