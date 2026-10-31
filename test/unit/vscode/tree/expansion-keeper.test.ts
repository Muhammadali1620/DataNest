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
