import { describe, expect, it } from 'vitest';
import { summarize } from '../../../../src/shared/tools/ping-stats';

describe('summarize', () => {
  it('counts, loses and averages', () => {
    expect(
      summarize([
        { ok: true, ms: 10 },
        { ok: true, ms: 20 },
        { ok: false },
        { ok: true, ms: 30.25 },
      ]),
    ).toEqual({ sent: 4, received: 3, lost: 1, lossPercent: 25, min: 10, avg: 20.1, max: 30.3 });
  });

  it('has no times when nothing connected', () => {
    expect(summarize([{ ok: false }, { ok: false }])).toEqual({
      sent: 2,
      received: 0,
      lost: 2,
      lossPercent: 100,
    });
  });

  it('copes with an empty series', () => {
    expect(summarize([])).toEqual({ sent: 0, received: 0, lost: 0, lossPercent: 0 });
  });

  it('ignores an ok attempt without a usable time', () => {
    expect(
      summarize([{ ok: true }, { ok: true, ms: Number.NaN }, { ok: true, ms: 5 }]),
    ).toMatchObject({
      sent: 3,
      received: 1,
      min: 5,
    });
  });

  it('rounds the loss to one decimal', () => {
    expect(summarize([{ ok: true, ms: 1 }, { ok: false }, { ok: false }]).lossPercent).toBe(66.7);
  });
});
