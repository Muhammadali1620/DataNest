import { describe, expect, it } from 'vitest';
import {
  formatElapsed,
  runStatusView,
  type RunStatusTexts,
} from '../../../../src/vscode/editor/run-status-text';

const TEXTS: RunStatusTexts = {
  running: 'Running… {0}',
  tooltip: 'Click to cancel',
};

describe('formatElapsed', () => {
  it('shows tenths below a second', () => {
    expect(formatElapsed(0)).toBe('0.0 s');
    expect(formatElapsed(50)).toBe('0.0 s');
    expect(formatElapsed(400)).toBe('0.4 s');
    expect(formatElapsed(999)).toBe('0.9 s');
  });

  it('shows seconds with one decimal up to a minute', () => {
    expect(formatElapsed(1000)).toBe('1.0 s');
    expect(formatElapsed(1250)).toBe('1.2 s');
    expect(formatElapsed(59_900)).toBe('59.9 s');
  });

  it('switches to minutes and whole seconds at a minute', () => {
    expect(formatElapsed(60_000)).toBe('1 m 00 s');
    expect(formatElapsed(65_000)).toBe('1 m 05 s');
    expect(formatElapsed(3_600_000)).toBe('60 m 00 s');
  });

  it('never counts down or shows a negative time', () => {
    expect(formatElapsed(-100)).toBe('0.0 s');
  });

  it('rounds down, so the shown time is never ahead of the real one', () => {
    expect(formatElapsed(1999)).toBe('1.9 s');
    expect(formatElapsed(119_999)).toBe('1 m 59 s');
  });
});

describe('runStatusView', () => {
  it('puts the elapsed time into the label and keeps the tooltip', () => {
    expect(runStatusView(1250, TEXTS)).toEqual({
      text: 'Running… 1.2 s',
      tooltip: 'Click to cancel',
    });
  });

  it('works with a translation that has the placeholder elsewhere', () => {
    expect(runStatusView(500, { running: '{0} — выполняется', tooltip: 'x' }).text).toBe(
      '0.5 s — выполняется',
    );
  });
});
