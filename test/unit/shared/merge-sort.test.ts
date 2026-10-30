import { describe, expect, it } from 'vitest';
import { mergeSortSteps, runSteps, runStepsPaused } from '../../../src/shared/merge-sort';

/** A deterministic shuffle, so a failure can be replayed. */
function shuffled(length: number, seed = 7): number[] {
  const items = Array.from({ length }, (_, index) => index);
  let state = seed;
  for (let index = length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const other = state % (index + 1);
    [items[index], items[other]] = [items[other] ?? 0, items[index] ?? 0];
  }
  return items;
}

const byNumber = (left: number, right: number): number => left - right;

describe('mergeSortSteps', () => {
  it.each([0, 1, 2, 31, 32, 33, 64, 65, 1000, 4099])('sorts %i items', (length) => {
    const items = shuffled(length);
    expect(runSteps(mergeSortSteps(items, byNumber))).toEqual(
      Array.from({ length }, (_, index) => index),
    );
  });

  it('sorts in place and returns the same array', () => {
    const items = [3, 1, 2];
    const sorted = runSteps(mergeSortSteps(items, byNumber));
    expect(sorted).toBe(items);
    expect(items).toEqual([1, 2, 3]);
  });

  it('keeps equal items in their original order', () => {
    // 500 items with only 7 distinct keys, so every merge meets many ties.
    const items = shuffled(500).map((value, position) => ({ key: value % 7, position }));
    const before = items.map((item) => ({ ...item }));
    runSteps(mergeSortSteps(items, (left, right) => left.key - right.key));
    const expected = [...before].sort(
      (left, right) => left.key - right.key || left.position - right.position,
    );
    expect(items).toEqual(expected);
  });

  it('handles items that are already sorted or reversed', () => {
    const ascending = Array.from({ length: 300 }, (_, index) => index);
    expect(runSteps(mergeSortSteps([...ascending], byNumber))).toEqual(ascending);
    expect(runSteps(mergeSortSteps([...ascending].reverse(), byNumber))).toEqual(ascending);
  });

  it('yields along the way on a big input and not at all on a tiny one', () => {
    const count = (items: number[]): number => {
      const steps = mergeSortSteps(items, byNumber);
      let yields = 0;
      while (steps.next().done !== true) {
        yields++;
      }
      return yields;
    };
    expect(count(shuffled(20_000))).toBeGreaterThan(10);
    expect(count(shuffled(10))).toBe(0);
  });

  it('survives a comparator that is not consistent', () => {
    // Mixed columns can make one; the sort must still end with every item kept.
    const items = shuffled(200);
    const sorted = runSteps(mergeSortSteps(items, (left, right) => ((left ^ right) & 1 ? -1 : 1)));
    expect([...sorted].sort(byNumber)).toEqual(Array.from({ length: 200 }, (_, index) => index));
  });
});

describe('runStepsPaused', () => {
  function* counting(yields: number): Generator<void, string, void> {
    for (let index = 0; index < yields; index++) {
      yield;
    }
    return 'done';
  }

  it('pauses only once a slice of work has passed', async () => {
    let clock = 0;
    let pauses = 0;
    // Every step "takes" 5 ms on this clock, so a 20 ms slice holds four steps.
    const result = await runStepsPaused(
      (function* () {
        for (let index = 0; index < 12; index++) {
          clock += 5;
          yield;
        }
        return 42;
      })(),
      {
        now: () => clock,
        sliceMs: 20,
        pause: () => {
          pauses++;
          return Promise.resolve();
        },
      },
    );
    expect(result).toBe(42);
    expect(pauses).toBe(3);
  });

  it('never pauses work that fits one slice', async () => {
    let pauses = 0;
    const result = await runStepsPaused(counting(50), {
      now: () => 0,
      pause: () => {
        pauses++;
        return Promise.resolve();
      },
    });
    expect(result).toBe('done');
    expect(pauses).toBe(0);
  });

  it('lets timers run between slices with the default pause', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    let clock = 0;
    try {
      await runStepsPaused(
        (function* () {
          for (let index = 0; index < 5; index++) {
            clock += 100;
            yield;
          }
        })(),
        { now: () => clock, sliceMs: 50 },
      );
    } finally {
      clearInterval(timer);
    }
    expect(ticks).toBeGreaterThan(0);
  });

  it('passes an error of the work on', async () => {
    const failing = (function* (): Generator<void, never, void> {
      yield;
      throw new Error('broken comparator');
    })();
    await expect(runStepsPaused(failing)).rejects.toThrow('broken comparator');
  });
});
