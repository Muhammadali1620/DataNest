// Keeps a table closed when it was only opened (V11.12). VS Code expands a row on a
// click (`workbench.tree.expandMode`), and a double click toggles it three times in all,
// so opening a table's rows with a double click also opened its columns. The keeper
// remembers whether the row was open before the pair of clicks and puts it back once the
// editor has finished toggling. Free of `vscode`: the host passes what expands and collapses.

import { DOUBLE_CLICK_MS } from './double-click';

export interface ExpansionTarget<N> {
  /** The id of a node, as the tree gives it out. */
  idOf(node: N): string;
  expand(node: N): void;
  collapse(node: N): void;
}

/** Long enough for the editor's own toggling after a double click, short enough not to flicker. */
export const SETTLE_MS = 250;

export class ExpansionKeeper<N> {
  private readonly open = new Set<string>();
  private readonly before = new Map<string, { readonly was: boolean; readonly at: number }>();

  constructor(
    private readonly target: ExpansionTarget<N>,
    private readonly later: (run: () => void, ms: number) => void = (run, ms) => {
      setTimeout(run, ms);
    },
    private readonly now: () => number = Date.now,
  ) {}

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
}
