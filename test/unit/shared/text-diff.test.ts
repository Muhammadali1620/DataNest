import { describe, expect, it } from 'vitest';
import { lineDiff } from '../../../src/shared/text-diff';

describe('lineDiff', () => {
  it('marks removed and added lines between the same ones', () => {
    expect(lineDiff('a\nb\nc\nd', 'a\nx\nc\nd\ne')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'remove', text: 'b' },
      { op: 'add', text: 'x' },
      { op: 'same', text: 'c' },
      { op: 'same', text: 'd' },
      { op: 'add', text: 'e' },
    ]);
  });

  it('keeps the longest run of common lines', () => {
    const ops = lineDiff('1\n2\n3\n4\n5', '0\n2\n3\n9\n5').map(
      (line) => `${line.op[0]}${line.text}`,
    );
    expect(ops).toEqual(['r1', 'a0', 's2', 's3', 'r4', 'a9', 's5']);
  });

  it('handles empty texts and line endings', () => {
    expect(lineDiff('', '')).toEqual([]);
    expect(lineDiff('', 'a')).toEqual([{ op: 'add', text: 'a' }]);
    expect(lineDiff('a\r\nb', 'a\nb')).toEqual([
      { op: 'same', text: 'a' },
      { op: 'same', text: 'b' },
    ]);
  });

  it('gives a plain replacement for texts too big to compare line by line', () => {
    const before = Array.from({ length: 3000 }, (_, index) => `old ${index}`).join('\n');
    const after = Array.from({ length: 3000 }, (_, index) => `new ${index}`).join('\n');
    const lines = lineDiff(before, after);
    expect(lines).toHaveLength(6000);
    expect(lines[0]).toEqual({ op: 'remove', text: 'old 0' });
    expect(lines[3000]).toEqual({ op: 'add', text: 'new 0' });
  });
});
