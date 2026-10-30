import { describe, expect, it } from 'vitest';
import { formatCount } from '../../../src/core/number-format';

describe('formatCount', () => {
  it('groups digits the way the language writes them', () => {
    expect(formatCount(1_000_000, 'en')).toBe('1,000,000');
    // Russian groups with a no-break space.
    expect(formatCount(1_000_000, 'ru')).toMatch(/^1\s000\s000$/u);
    expect(formatCount(1_000_000, 'de')).toBe('1.000.000');
  });

  it('takes the language ids VS Code uses', () => {
    expect(formatCount(1234, 'zh-cn')).toBe('1,234');
    expect(formatCount(1234, 'pt-br')).toBe('1.234');
  });

  it('falls back to the system way for a tag it cannot read', () => {
    expect(formatCount(1234, 'not a language!')).toBe((1234).toLocaleString());
  });

  it('uses the system way when no language is given', () => {
    expect(formatCount(42)).toBe((42).toLocaleString());
  });

  it('leaves small and fractional numbers readable', () => {
    expect(formatCount(7, 'ru')).toBe('7');
    expect(formatCount(0, 'en')).toBe('0');
    expect(formatCount(-1500, 'en')).toBe('-1,500');
  });
});
