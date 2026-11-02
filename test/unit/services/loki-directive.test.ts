import { describe, expect, it } from 'vitest';
import { leadingDirective, setLeadingDirective } from '../../../src/services/loki-directive';

describe('setLeadingDirective', () => {
  it('adds the line above a query that has none', () => {
    expect(setLeadingDirective('{app="shop"}', 'range', '6h')).toBe('# range: 6h\n{app="shop"}');
  });

  it('adds the line to an empty editor', () => {
    expect(setLeadingDirective('', 'tail', '30s')).toBe('# tail: 30s\n');
  });

  it('changes the line it finds in the leading comments', () => {
    expect(setLeadingDirective('# range: 1h\n{a="b"}', 'range', '7d')).toBe('# range: 7d\n{a="b"}');
  });

  it('is not fussy about case or spaces when it finds the line', () => {
    expect(setLeadingDirective('#   RANGE :   1h\n{a="b"}', 'range', '15m')).toBe(
      '# range: 15m\n{a="b"}',
    );
  });

  it('keeps the other directives of a line and of its neighbours', () => {
    expect(setLeadingDirective('# range: 1h # step: 1m\n# limit: 5\n{a="b"}', 'range', '2h')).toBe(
      '# range: 2h # step: 1m\n# limit: 5\n{a="b"}',
    );
    expect(setLeadingDirective('# step: 1m # range: 1h\n{a="b"}', 'range', '2h')).toBe(
      '# step: 1m # range: 2h\n{a="b"}',
    );
  });

  it('adds a different key without touching the others', () => {
    expect(setLeadingDirective('# range: 1h\n{a="b"}', 'tail', '30s')).toBe(
      '# tail: 30s\n# range: 1h\n{a="b"}',
    );
  });

  it('does not change a directive below the query', () => {
    expect(setLeadingDirective('{a="b"}\n# range: 1h', 'range', '2h')).toBe(
      '# range: 2h\n{a="b"}\n# range: 1h',
    );
  });

  it('keeps the line ending of the text', () => {
    expect(setLeadingDirective('# range: 1h\r\n{a="b"}', 'range', '2h')).toBe(
      '# range: 2h\r\n{a="b"}',
    );
    expect(setLeadingDirective('{a="b"}\r\n', 'range', '2h')).toBe('# range: 2h\r\n{a="b"}\r\n');
  });
});

describe('leadingDirective', () => {
  it('reads the value of a directive in the leading comments', () => {
    expect(leadingDirective('# range: 6h\n{a="b"}', 'range')).toBe('6h');
    expect(leadingDirective('# step: 1m # range: 3d\n{a="b"}', 'range')).toBe('3d');
  });

  it('gives nothing when it is not there or is below the query', () => {
    expect(leadingDirective('{a="b"}', 'range')).toBeUndefined();
    expect(leadingDirective('{a="b"}\n# range: 6h', 'range')).toBeUndefined();
    expect(leadingDirective('# step: 1m\n{a="b"}', 'range')).toBeUndefined();
  });
});
