import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { parseStatement } from '../../../../src/drivers/loki/directives';

describe('parseStatement', () => {
  it('finds a query and no directives in a plain statement', () => {
    expect(parseStatement('{app="shop"}')).toEqual({ directives: {}, hasQuery: true });
  });

  it('reads every directive from the comments above the query', () => {
    const parsed = parseStatement(
      [
        '# range: 6h',
        '# step: 1m',
        '# direction: forward',
        '# limit: 250',
        '{app="shop"} |= "error"',
      ].join('\n'),
    );
    expect(parsed).toEqual({
      directives: { range: '6h', step: '1m', direction: 'forward', limit: 250 },
      hasQuery: true,
    });
  });

  it('reads a start and an end of its own', () => {
    expect(
      parseStatement('# start: 2026-11-01T00:00:00Z\n# end: now-1h\n{a="b"}').directives,
    ).toEqual({ start: '2026-11-01T00:00:00Z', end: 'now-1h' });
  });

  it('reads two directives from one line, and is not fussy about case or spaces', () => {
    expect(parseStatement('#   RANGE :  2h  # direction: BACKWARD\n{a="b"}').directives).toEqual({
      range: '2h',
      direction: 'backward',
    });
  });

  it('takes the last of a directive that is repeated', () => {
    expect(parseStatement('# range: 1h\n# range: 3h\n{a="b"}').directives.range).toBe('3h');
  });

  it('ignores comments that are not directives', () => {
    const parsed = parseStatement('# what this does\n# note: later\n{a="b"}');
    expect(parsed.directives).toEqual({});
    expect(parsed.hasQuery).toBe(true);
  });

  it('does not read a directive inside a string', () => {
    expect(parseStatement('{a="# range: 9h"}').directives).toEqual({});
  });

  it('does not read other comment styles', () => {
    expect(parseStatement('// range: 9h\n{a="b"}').directives).toEqual({});
  });

  it('sees that a statement of directives alone holds no query', () => {
    expect(parseStatement('# range: 6h')).toEqual({ directives: { range: '6h' }, hasQuery: false });
    expect(parseStatement('  \n# range: 6h\n  ').hasQuery).toBe(false);
    expect(parseStatement('').hasQuery).toBe(false);
  });

  it('refuses a directive with a bad value, saying so as a syntax error', () => {
    for (const [text, pattern] of [
      ['# range: soon', /range of time/u],
      ['# step: fast', /not a step/u],
      ['# direction: sideways', /forward or backward/u],
      ['# limit: 0', /whole number/u],
      ['# limit: 1.5', /whole number/u],
      ['# limit: many', /whole number/u],
    ] as const) {
      expect(() => parseStatement(`${text}\n{a="b"}`), text).toThrow(pattern);
      try {
        parseStatement(`${text}\n{a="b"}`);
      } catch (error) {
        expect(error).toBeInstanceOf(DbError);
        expect((error as DbError).code).toBe('syntax');
      }
    }
  });
});
