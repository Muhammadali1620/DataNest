import { describe, expect, it } from 'vitest';
import { filterNames, nameFilter, parsePatterns } from '../../../src/shared/name-filter';

const NAMES = ['app', 'app_test', 'app_prod', 'billing', 'Analytics', 'a.b', 'a_b'];

describe('filterNames', () => {
  it('shows everything without patterns', () => {
    expect(filterNames(NAMES, [])).toEqual(NAMES);
    expect(filterNames(NAMES, ['', '  '])).toEqual(NAMES);
  });

  it('shows exact names and keeps the original order', () => {
    expect(filterNames(NAMES, ['billing', 'app'])).toEqual(['app', 'billing']);
  });

  it('understands * and ?', () => {
    expect(filterNames(NAMES, ['app*'])).toEqual(['app', 'app_test', 'app_prod']);
    expect(filterNames(NAMES, ['app_????'])).toEqual(['app_test', 'app_prod']);
  });

  it('hides what a ! pattern matches, with or without showing patterns', () => {
    expect(filterNames(NAMES, ['app*', '!app_test'])).toEqual(['app', 'app_prod']);
    expect(filterNames(NAMES, ['!app*'])).toEqual(['billing', 'Analytics', 'a.b', 'a_b']);
    expect(filterNames(NAMES, ['!'])).toEqual(NAMES);
  });

  it('ignores case, as people type names', () => {
    expect(filterNames(NAMES, ['analytics'])).toEqual(['Analytics']);
    expect(filterNames(NAMES, ['APP'])).toEqual(['app']);
  });

  it('treats other characters literally, so a dot is a dot', () => {
    expect(filterNames(NAMES, ['a.b'])).toEqual(['a.b']);
    expect(filterNames(['a(b)', 'ab', 'a+b'], ['a(b)', 'a+b'])).toEqual(['a(b)', 'a+b']);
  });

  it('trims patterns', () => {
    expect(nameFilter(['  billing  '])('billing')).toBe(true);
  });
});

describe('parsePatterns', () => {
  it('splits on commas and new lines and drops blanks', () => {
    expect(parsePatterns('app_*, !app_test\nbilling,,\n ')).toEqual([
      'app_*',
      '!app_test',
      'billing',
    ]);
    expect(parsePatterns('')).toEqual([]);
  });
});
