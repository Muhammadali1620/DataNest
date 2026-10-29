import { describe, expect, it } from 'vitest';
import { newObjectId } from '../../../../src/core/mongo/object-id';

describe('newObjectId (V7.5)', () => {
  it('starts with the seconds, so ids sort by creation time', () => {
    const id = newObjectId(Date.UTC(2026, 9, 29) + 999);
    expect(id).toMatch(/^[0-9a-f]{24}$/);
    expect(Number.parseInt(id.slice(0, 8), 16)).toBe(Date.UTC(2026, 9, 29) / 1000);
    expect(newObjectId(0).slice(0, 8)).toBe('00000000');
  });

  it('keeps the random part of the run and counts up', () => {
    const a = newObjectId(1000);
    const b = newObjectId(1000);
    expect(a.slice(8, 18)).toBe(b.slice(8, 18));
    expect(
      (Number.parseInt(b.slice(18), 16) - Number.parseInt(a.slice(18), 16) + 0x1000000) % 0x1000000,
    ).toBe(1);
    expect(a).not.toBe(b);
  });

  it('never repeats within a run', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => newObjectId()));
    expect(ids.size).toBe(1000);
  });
});
