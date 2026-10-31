// The tree has no double-click event: a click on an item runs its command, so the
// command itself tells a second click on the same item from a new one by the time.

/** Two clicks on one item closer than this count as a double click. */
export const DOUBLE_CLICK_MS = 500;

export class DoubleClickDetector {
  private lastKey: string | undefined;
  private lastAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly windowMs: number = DOUBLE_CLICK_MS,
  ) {}

  /** True when this click is the second of a pair; a third click starts a new pair. */
  click(key: string): boolean {
    const at = this.now();
    const second = key === this.lastKey && at - this.lastAt <= this.windowMs;
    this.lastKey = second ? undefined : key;
    this.lastAt = second ? Number.NEGATIVE_INFINITY : at;
    return second;
  }
}
