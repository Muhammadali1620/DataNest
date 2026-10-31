import { describe, expect, it } from 'vitest';
import {
  CLICK_SYNC_MS,
  ExpansionKeeper,
  JUDGE_MS,
} from '../../../../src/vscode/tree/expansion-keeper';

function setup(options: { enabled?: () => boolean; onWait?: (ms: number) => void } = {}) {
  const log: string[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  let now = 1000;
  const keeper = new ExpansionKeeper<string>(
    {
      idOf: (node) => node,
      expand: (node) => log.push(`expand ${node}`),
      collapse: (node) => log.push(`collapse ${node}`),
    },
    (run, ms) => timers.push({ run, ms }),
    () => now,
    (ms) => {
      now += ms;
      options.onWait?.(ms);
      return Promise.resolve();
    },
    options.enabled,
  );
  return {
    keeper,
    log,
    timers,
    advance: (ms: number) => {
      now += ms;
    },
    flush: () => {
      for (const timer of timers.splice(0)) {
        timer.run();
      }
    },
    flushJudging: () => {
      for (const timer of timers.splice(0).filter((item) => item.ms === JUDGE_MS)) {
        timer.run();
      }
    },
  };
}

describe('ExpansionKeeper: a table opens and closes by its arrow only', () => {
  it('closes at once a table the double click expanded (command first)', () => {
    const { keeper, log, advance } = setup();
    keeper.clicked('t');
    advance(120);
    keeper.clicked('t');
    keeper.expanded('t');
    expect(log).toEqual(['collapse t']);
  });

  it('closes at once a table the double click expanded (toggle first)', () => {
    const { keeper, log, advance } = setup();
    keeper.clicked('t');
    advance(120);
    keeper.expanded('t');
    expect(log).toEqual([]);
    keeper.clicked('t');
    expect(log).toEqual(['collapse t']);
  });

  it('opens again at once a table the double click collapsed', () => {
    const { keeper, log, advance } = setup();
    keeper.expanded('t');
    advance(1000);
    keeper.clicked('t');
    advance(120);
    keeper.clicked('t');
    keeper.collapsed('t');
    expect(log).toEqual(['expand t']);
  });

  it('opens again a collapsed table when the toggle comes before the second click', () => {
    const { keeper, log, advance } = setup();
    keeper.expanded('t');
    advance(1000);
    keeper.clicked('t');
    advance(80);
    keeper.collapsed('t');
    keeper.clicked('t');
    expect(log).toEqual(['expand t']);
  });

  it('never touches a toggle by the arrow, which has no click before it', () => {
    const { keeper, log, timers } = setup();
    keeper.expanded('t');
    keeper.collapsed('t');
    keeper.expanded('t');
    expect(log).toEqual([]);
    expect(timers).toEqual([]);
  });

  it('leaves the arrow click that follows one click on the name alone', () => {
    const { keeper, log, advance, flushJudging } = setup();
    keeper.clicked('t');
    advance(100);
    keeper.expanded('t');
    advance(JUDGE_MS);
    flushJudging();
    advance(200);
    // A late second click does not undo a toggle that was taken as the user's own.
    keeper.clicked('t');
    expect(log).toEqual([]);
  });

  it('does not take the editor’s echo of an undo for a toggle of the user', () => {
    const { keeper, log, advance } = setup();
    keeper.clicked('t');
    advance(100);
    keeper.clicked('t');
    keeper.expanded('t');
    expect(log).toEqual(['collapse t']);
    keeper.collapsed('t');
    expect(log).toEqual(['collapse t']);
    // The next toggle by the arrow is the user's own again.
    keeper.expanded('t');
    expect(log).toEqual(['collapse t']);
  });

  it('forgets an echo that never came', () => {
    const { keeper, log, advance, flush } = setup();
    keeper.clicked('t');
    advance(100);
    keeper.clicked('t');
    keeper.expanded('t');
    flush();
    advance(5000);
    // Without the echo, a later double click is judged on its own.
    keeper.clicked('t');
    advance(100);
    keeper.clicked('t');
    keeper.collapsed('t');
    expect(log).toEqual(['collapse t', 'expand t']);
  });

  it('counts two clicks far apart as two single clicks', () => {
    const { keeper, log, advance, flushJudging } = setup();
    keeper.clicked('t');
    advance(700);
    keeper.clicked('t');
    keeper.expanded('t');
    advance(JUDGE_MS);
    flushJudging();
    expect(log).toEqual([]);
  });

  it('takes a third click for the start of a new pair', () => {
    const { keeper, log, advance } = setup();
    keeper.clicked('t');
    advance(100);
    keeper.clicked('t');
    keeper.expanded('t');
    keeper.collapsed('t');
    advance(100);
    keeper.clicked('t');
    keeper.expanded('t');
    // Only the first pair was undone: the third click alone is not a double click.
    expect(log).toEqual(['collapse t']);
  });

  it('keeps the rows apart', () => {
    const { keeper, log, advance } = setup();
    keeper.clicked('a');
    advance(100);
    keeper.clicked('b');
    keeper.expanded('b');
    expect(log).toEqual([]);
  });

  it('ignores a toggle that changes nothing', () => {
    const { keeper, log, advance } = setup();
    keeper.expanded('t');
    advance(1000);
    keeper.clicked('t');
    advance(100);
    keeper.clicked('t');
    keeper.expanded('t');
    expect(log).toEqual([]);
  });

  it('leaves the editor alone when the setting is off', async () => {
    const { keeper, log, advance } = setup({ enabled: () => false });
    keeper.clicked('t');
    advance(100);
    keeper.clicked('t');
    keeper.expanded('t');
    await keeper.quiet('t');
    expect(log).toEqual([]);
  });

  it('follows the setting at every call', () => {
    let on = false;
    const { keeper, log, advance } = setup({ enabled: () => on });
    keeper.clicked('t');
    advance(100);
    keeper.clicked('t');
    keeper.expanded('t');
    expect(log).toEqual([]);
    on = true;
    advance(1000);
    keeper.collapsed('t');
    advance(1000);
    keeper.clicked('t');
    advance(100);
    keeper.clicked('t');
    keeper.expanded('t');
    expect(log).toEqual(['collapse t']);
  });
});

describe('ExpansionKeeper.quiet', () => {
  it('lets an arrow click have its children at once', async () => {
    const waits: number[] = [];
    const { keeper } = setup({ onWait: (ms) => waits.push(ms) });
    await keeper.quiet('t');
    expect(waits).toEqual([CLICK_SYNC_MS]);
  });

  it('holds the children while the second click may still come, but not beyond the judging time', async () => {
    const waits: number[] = [];
    const { keeper } = setup({ onWait: (ms) => waits.push(ms) });
    keeper.clicked('t');
    await keeper.quiet('t');
    const total = waits.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(JUDGE_MS);
    expect(total).toBeLessThanOrEqual(JUDGE_MS + CLICK_SYNC_MS + 1);
  });

  it('lets go as soon as the second click came', async () => {
    const waits: number[] = [];
    const ref: { keeper?: ExpansionKeeper<string> } = {};
    const { keeper } = setup({
      onWait: (ms) => {
        waits.push(ms);
        if (waits.length === 1) {
          ref.keeper?.clicked('t');
        }
      },
    });
    ref.keeper = keeper;
    keeper.clicked('t');
    await keeper.quiet('t');
    expect(waits).toEqual([CLICK_SYNC_MS]);
  });

  it('does not hold the children of a row clicked long ago', async () => {
    const waits: number[] = [];
    const { keeper, advance } = setup({ onWait: (ms) => waits.push(ms) });
    keeper.clicked('t');
    advance(2000);
    await keeper.quiet('t');
    expect(waits).toEqual([CLICK_SYNC_MS]);
  });
});
