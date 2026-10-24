// How a running query is described in the status bar. Free of `vscode`, so the
// wording and the rounding are covered by unit tests.

export interface RunStatusTexts {
  /** `{0}` is the elapsed time, already formatted. */
  readonly running: string;
  readonly tooltip: string;
}

/**
 * Elapsed time, short enough to sit in the status bar and steady enough not to
 * jitter: tenths below a minute, then minutes and whole seconds.
 */
export function formatElapsed(milliseconds: number): string {
  const ms = Math.max(0, milliseconds);
  if (ms < 1000) {
    return `${(Math.floor(ms / 100) / 10).toFixed(1)} s`;
  }
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    const tenths = Math.floor((ms % 1000) / 100);
    return `${totalSeconds}.${tenths} s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} m ${String(seconds).padStart(2, '0')} s`;
}

export interface RunStatusView {
  readonly text: string;
  readonly tooltip: string;
}

export function runStatusView(elapsedMs: number, texts: RunStatusTexts): RunStatusView {
  return {
    text: texts.running.replace('{0}', formatElapsed(elapsedMs)),
    tooltip: texts.tooltip,
  };
}
