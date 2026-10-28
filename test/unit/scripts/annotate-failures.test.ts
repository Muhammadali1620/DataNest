import { describe, expect, it } from 'vitest';
import { failureAnnotation, MAX_LINES } from '../../../scripts/annotate-failures.mjs';

describe('failureAnnotation', () => {
  it('keeps mocha output from "N failing" on, as one escaped line', () => {
    const output = [
      '  70 passing (19s)',
      '  2 failing',
      '',
      '  1) project connections',
      '     AssertionError: 50% done, a: b',
      '\u001b[31m  red\u001b[0m',
    ].join('\r\n');
    expect(failureAnnotation('E2E (windows)', output)).toBe(
      '::error title=E2E (windows)::2 failing%0A%0A  1) project connections%0A     AssertionError: 50%25 done, a: b%0A  red',
    );
  });

  it('escapes the title as a property', () => {
    expect(failureAnnotation('a: b, c', 'x')).toBe('::error title=a%3A b%2C c::x');
  });

  it('falls back to the last lines when there is no failure summary', () => {
    const output = Array.from({ length: MAX_LINES + 20 }, (_, index) => `line ${index}`).join('\n');
    const message = failureAnnotation('t', output).split('::').at(-1) ?? '';
    const lines = message.split('%0A');
    expect(lines).toHaveLength(MAX_LINES);
    expect(lines.at(-1)).toBe(`line ${MAX_LINES + 19}`);
  });

  it('says so when there was no output at all', () => {
    expect(failureAnnotation('t', '\n')).toBe('::error title=t::No output');
  });
});
