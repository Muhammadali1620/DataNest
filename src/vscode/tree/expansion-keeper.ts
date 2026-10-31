// Keeps a table closed when it was only opened (V11.12). VS Code expands a row on a
// click (`workbench.tree.expandMode`), and a double click toggles it twice (open, close),
// so opening a table's rows with a double click used to flash its columns. Two parts:
// - `quiet` holds the children back while a click on the label may still be the first of a
//   double click, so the row opens empty and closes again with nothing ever drawn; an arrow
//   click is not a click on the label and gets its children at once (D116);
// - the keeper remembers whether the row was open before the pair of clicks and puts it
//   back once the editor has finished toggling, should it still end up the other way.
// Free of `vscode`: the host passes what expands and collapses.

import { DOUBLE_CLICK_MS } from './double-click';

export interface ExpansionTarget<N> {
  /** The id of a node, as the tree gives it out. */
  idOf(node: N): string;
  expand(node: N): void;
  collapse(node: N): void;
}

/** Long enough for the editor's own toggling after a double click, short enough not to flicker. */
export const SETTLE_MS = 250;

/** The command of a click may run just after the toggle it belongs to; this is the wait for it. */
export const CLICK_SYNC_MS = 60;

/** A click this recent belongs to the toggle that is asking for children. */
const SAME_GESTURE_MS = 250;

/** Extra wait beyond the double-click window, so a second click is surely in. */
const GRACE_MS = 40;

/** Never hold children back longer than this, whatever the clicks do. */
const MAX_HOLD_MS = 1500;

export class ExpansionKeeper<N> {
  private readonly open = new Set<string>();
  private readonly before = new Map<string, { readonly was: boolean; readonly at: number }>();

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
  ) {}

  private readonly lastClick = new Map<string, number>();

  /** The editor expanded a row. */
  expanded(node: N): void {
    this.open.add(this.target.idOf(node));
  }

  /** The editor collapsed a row. */
  collapsed(node: N): void {
    this.open.delete(this.target.idOf(node));
  }

  /** A click on a row, before the editor has toggled it for the first time. */
  clicked(node: N): void {
    const id = this.target.idOf(node);
    const at = this.now();
    this.lastClick.set(id, at);
    const first = this.before.get(id);
    // A click long after the last one starts a new pair; the second of a pair keeps the first's record.
    if (first === undefined || at - first.at > DOUBLE_CLICK_MS) {
      this.before.set(id, { was: this.open.has(id), at });
    }
  }

  /** The pair of clicks ended in an action: the row goes back to how it was. */
  settle(node: N): void {
    const id = this.target.idOf(node);
    const was = this.before.get(id)?.was;
    this.before.delete(id);
    if (was === undefined) {
      return;
    }
    this.later(() => {
      if (this.open.has(id) === was) {
        return;
      }
      if (was) {
        this.target.expand(node);
      } else {
        this.target.collapse(node);
      }
    }, SETTLE_MS);
  }

  /**
   * The editor asks for the children of a row it just expanded. When that was a click on
   * the label, wait out the double-click window first: a second click closes the row again
   * before anything was drawn. An expansion by the arrow comes back at once.
   */
  async quiet(node: N): Promise<void> {
    const id = this.target.idOf(node);
    // The command of the click may be running a moment after the toggle.
    await this.wait(CLICK_SYNC_MS);
    const started = this.now();
    let clicked = this.lastClick.get(id);
    if (clicked === undefined || started - clicked > SAME_GESTURE_MS) {
      return;
    }
    while (clicked !== undefined) {
      const rest = clicked + DOUBLE_CLICK_MS + GRACE_MS - this.now();
      if (rest <= 0 || this.now() - started > MAX_HOLD_MS) {
        return;
      }
      await this.wait(rest);
      const latest = this.lastClick.get(id);
      // Another click came while waiting: wait out its window as well.
      clicked = latest !== undefined && latest > clicked ? latest : undefined;
    }
  }
}
