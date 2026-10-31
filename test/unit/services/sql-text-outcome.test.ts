import { describe, expect, it } from 'vitest';
import { revealColumn, sqlTextOutcome } from '../../../src/services/sql-text-outcome';

describe('sqlTextOutcome', () => {
  it('is ok when every statement worked', () => {
    expect(sqlTextOutcome([{}, {}], false)).toEqual({ ok: true });
    expect(sqlTextOutcome([], false)).toEqual({ ok: true });
  });

  it('carries the message of the first failed statement', () => {
    expect(
      sqlTextOutcome(
        [
          {},
          { error: { code: 'syntax', message: 'near "FORM"' } },
          { error: { code: 'x', message: 'later' } },
        ],
        false,
      ),
    ).toEqual({ ok: false, error: 'near "FORM"' });
  });

  it('gives no message for a cancel: it was the user who stopped it', () => {
    expect(sqlTextOutcome([{ error: { code: 'cancelled', message: 'Cancelled' } }], true)).toEqual({
      ok: false,
    });
    expect(sqlTextOutcome([{}], true)).toEqual({ ok: false });
  });
});

describe('revealColumn', () => {
  it('keeps the column the panel is in', () => {
    expect(revealColumn(2, -2)).toBe(2);
    expect(revealColumn(1, -2)).toBe(1);
  });

  it('opens a panel without a column beside the editor', () => {
    expect(revealColumn(undefined, -2)).toBe(-2);
  });
});
