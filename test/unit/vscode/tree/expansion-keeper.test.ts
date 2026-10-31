import { describe, expect, it } from 'vitest';
import { ExpansionKeeper, SETTLE_MS } from '../../../../src/vscode/tree/expansion-keeper';

function setup() {
  const log: string[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  let now = 0;
  const keeper = new ExpansionKeeper<string>(
    {
      idOf: (node) => node,
      expand: (node) => log.push(`expand ${node}`),
      collapse: (node) => log.push(`collapse ${node}`),
    },
    (run, ms) => timers.push({ run, ms }),
    () => now,
  );
  return {
    keeper,
    log,
    timers,
    wait: (ms: number) => {
      now += ms;
    },
    flush: () => {
      for (const timer of timers.splice(0)) {
        timer.run();
      }
    },
  };
}

describe('ExpansionKeeper', () => {
  it('collapses a table the double click expanded', () => {
    const { keeper, log, flush, timers } = setup();
    keeper.clicked('t');
    keeper.expanded('t');
    keeper.clicked('t');
    keeper.settle('t');
    expect(timers.map((timer) => timer.ms)).toEqual([SETTLE_MS]);
    flush();
    expect(log).toEqual(['collapse t']);
  });

  it('expands again a table that was open and got closed', () => {
    const { keeper, log, flush } = setup();
    keeper.expanded('t');
    keeper.clicked('t');
    keeper.collapsed('t');
    keeper.clicked('t');
    keeper.settle('t');
    flush();
    expect(log).toEqual(['expand t']);
  });

  it('does nothing when the row ended up as it was', () => {
    const { keeper, log, flush } = setup();
    keeper.clicked('t');
    keeper.clicked('t');
    keeper.settle('t');
    flush();
    expect(log).toEqual([]);
    keeper.expanded('u');
    keeper.clicked('u');
    keeper.clicked('u');
    keeper.settle('u');
    flush();
    expect(log).toEqual([]);
  });

  it('judges the row by its state when the timer fires, not when it was set', () => {
    const { keeper, log, flush } = setup();
    keeper.clicked('t');
    keeper.expanded('t');
    keeper.settle('t');
    keeper.collapsed('t');
    flush();
    expect(log).toEqual([]);
  });

  it('remembers the state before the first click of a pair, not the second', () => {
    const { keeper, log, flush, wait } = setup();
    keeper.clicked('t');
    wait(100);
    keeper.expanded('t');
    keeper.clicked('t');
    keeper.settle('t');
    flush();
    expect(log).toEqual(['collapse t']);
  });

  it('forgets a single click after the double click window', () => {
    const { keeper, log, flush, wait } = setup();
    keeper.clicked('t');
    keeper.expanded('t');
    wait(2000);
    keeper.clicked('t');
    keeper.collapsed('t');
    keeper.clicked('t');
    keeper.settle('t');
    flush();
    // The pair began with the row open, and the row ended closed: it opens again.
    expect(log).toEqual(['expand t']);
  });

  it('ignores a settle with no click before it, and keeps rows apart', () => {
    const { keeper, log, flush } = setup();
    keeper.settle('t');
    keeper.clicked('a');
    keeper.expanded('b');
    keeper.settle('b');
    flush();
    expect(log).toEqual([]);
  });
});

describe('ExpansionKeeper.quiet', () => {
  /** A fake clock: `wait` moves time and runs what the test queued for that moment. */
  function clocked() {
    let now = 1000;
    const waits: number[] = [];
    const between: (() => void)[] = [];
    const keeper = new ExpansionKeeper<string>(
      { idOf: (node) => node, expand: () => undefined, collapse: () => undefined },
      () => undefined,
      () => now,
      (ms) => {
        waits.push(ms);
        now += ms;
        between.shift()?.();
        return Promise.resolve();
      },
    );
    return {
      keeper,
      waits,
      between,
      at: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('gives the children of an arrow click at once, after the short sync wait', async () => {
    const { keeper, waits } = clocked();
    await keeper.quiet('t');
    expect(waits).toEqual([60]);
  });

  it('holds the children of a click on the label until the double-click window is over', async () => {
    const { keeper, waits, at } = clocked();
    keeper.clicked('t');
    const clickedAt = at();
    await keeper.quiet('t');
    // 60 ms to sync, then the rest of the 500 ms window and the grace.
    expect(waits).toEqual([60, 480]);
    expect(at()).toBe(clickedAt + 540);
  });

  it('waits out the window of a second click too', async () => {
    const { keeper, waits, between, at } = clocked();
    keeper.clicked('t');
    // The second click lands while the first window is still running.
    between.push(
      () => undefined,
      () => {
        keeper.clicked('t');
      },
    );
    await keeper.quiet('t');
    const last = at() - 40;
    expect(waits.length).toBe(3);
    expect(waits[2]).toBeGreaterThan(400);
    expect(last).toBeGreaterThan(1000 + 500);
  });

  it('does not hold children for a click that was long ago', async () => {
    const { keeper, waits, advance } = clocked();
    keeper.clicked('t');
    advance(2000);
    await keeper.quiet('t');
    expect(waits).toEqual([60]);
  });

  it('does not hold the children of another row', async () => {
    const { keeper, waits } = clocked();
    keeper.clicked('other');
    await keeper.quiet('t');
    expect(waits).toEqual([60]);
  });
});
