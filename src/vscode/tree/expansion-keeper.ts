// A table opens and closes by its arrow only (V11.12, D121). What the editor's tree does,
// measured in VS Code 1.105: a single click on a label that has a command runs the command and
// does not toggle the row (the row only toggles by its arrow), but a double click on the label
// toggles it (`expandOnDoubleClick`, not configurable for an extension's view). So the keeper
// puts a row back at once when the toggle belongs to a double click on its label:
// - the first click (the item's command) is remembered; a second command of the same row within
//   the double-click window makes the pair;
// - a toggle event of that row is judged against the pair, whichever of the two reaches us first:
//   with the second click in, the toggle is undone immediately; with only the first click in, the
//   toggle waits `JUDGE_MS` for the second one and counts as the user's own (an arrow click close
//   after a click) when it does not come;
// - an arrow click alone has no click before it, so it is never touched and never delayed;
// - `quiet` holds the children back for those few milliseconds, so a row that opens by a double
//   click closes again before anything was drawn.
// The editor offers no way to cancel the toggle itself; the undo takes one round trip.
// Free of `vscode`: the host passes what expands and collapses.

import { DOUBLE_CLICK_MS } from './double-click';

export interface ExpansionTarget<N> {
  /** The id of a node, as the tree gives it out. */
  idOf(node: N): string;
  expand(node: N): void;
  collapse(node: N): void;
}

/** How long a toggle waits for the second click of a pair before it counts as the user's own. */
export const JUDGE_MS = 150;

/** The command of a click may run just after the toggle it belongs to; this is the wait for it. */
export const CLICK_SYNC_MS = 60;

/** An undo that gets no echo from the editor within this time is forgotten. */
const ECHO_MS = 1500;

/** Never hold children back longer than this, whatever the clicks do. */
const MAX_HOLD_MS = 600;

interface Toggle<N> {
  readonly node: N;
  /** True when the row was open before the toggle. */
  readonly was: boolean;
}

export class ExpansionKeeper<N> {
  private readonly open = new Set<string>();
  private readonly lastClick = new Map<string, number>();
  private readonly secondClick = new Map<string, number>();
  private readonly pending = new Map<string, Toggle<N>>();
  /** Rows the keeper itself is toggling back: the editor's echo of it is not a user toggle. */
  private readonly echo = new Map<string, boolean>();

  constructor(
    private readonly target: ExpansionTarget<N>,
    private readonly later: (run: () => void, ms: number) => void = (run, ms) => {
      setTimeout(run, ms);
    },
    private readonly now: () => number = Date.now,
    private readonly wait: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      }),
    /** False leaves the editor's own behaviour alone (`datanest.tree.expandOnlyByArrow`). */
    private readonly enabled: () => boolean = () => true,
  ) {}

  /** The editor expanded a row. */
  expanded(node: N): void {
    this.toggled(node, true);
  }

  /** The editor collapsed a row. */
  collapsed(node: N): void {
    this.toggled(node, false);
  }

  /** A click on a row: the command of the item runs, before or after the toggle it belongs to. */
  clicked(node: N): void {
    const id = this.target.idOf(node);
    const at = this.now();
    const first = this.lastClick.get(id);
    if (first !== undefined && at - first <= DOUBLE_CLICK_MS) {
      // The second of a pair; a third click starts a new pair.
      this.lastClick.delete(id);
      this.secondClick.set(id, at);
      const toggle = this.pending.get(id);
      if (toggle !== undefined) {
        this.pending.delete(id);
        this.undo(id, toggle);
      }
      return;
    }
    this.secondClick.delete(id);
    this.lastClick.set(id, at);
  }

  /**
   * The editor asks for the children of a row it just expanded. When a click on the label
   * came just before, wait for the second click of a pair: it undoes the expansion before
   * anything was drawn. An expansion by the arrow comes back at once.
   */
  async quiet(node: N): Promise<void> {
    if (!this.enabled()) {
      return;
    }
    const id = this.target.idOf(node);
    // The command of the click may be running a moment after the toggle.
    await this.wait(CLICK_SYNC_MS);
    const started = this.now();
    while (this.mayBeFirstClick(id) && this.now() - started < Math.min(JUDGE_MS, MAX_HOLD_MS)) {
      await this.wait(Math.max(1, JUDGE_MS - (this.now() - started)));
    }
  }

  private mayBeFirstClick(id: string): boolean {
    const first = this.lastClick.get(id);
    return first !== undefined && this.now() - first <= DOUBLE_CLICK_MS;
  }

  private toggled(node: N, expanded: boolean): void {
    const id = this.target.idOf(node);
    const was = this.open.has(id);
    if (expanded) {
      this.open.add(id);
    } else {
      this.open.delete(id);
    }
    if (this.echo.get(id) === expanded) {
      this.echo.delete(id);
      return;
    }
    if (!this.enabled() || was === expanded) {
      return;
    }
    const toggle: Toggle<N> = { node, was };
    const second = this.secondClick.get(id);
    if (second !== undefined && this.now() - second <= DOUBLE_CLICK_MS) {
      // The pair is complete: this toggle is the editor's double-click expand/collapse.
      this.secondClick.delete(id);
      this.undo(id, toggle);
      return;
    }
    if (this.mayBeFirstClick(id)) {
      // The second click may still be on its way; without it the toggle is the user's own.
      this.pending.set(id, toggle);
      this.later(() => {
        if (this.pending.get(id) === toggle) {
          this.pending.delete(id);
        }
      }, JUDGE_MS);
    }
  }

  private undo(id: string, toggle: Toggle<N>): void {
    this.echo.set(id, toggle.was);
    this.later(() => {
      if (this.echo.get(id) === toggle.was) {
        this.echo.delete(id);
      }
    }, ECHO_MS);
    if (toggle.was) {
      this.target.expand(toggle.node);
    } else {
      this.target.collapse(toggle.node);
    }
  }
}
