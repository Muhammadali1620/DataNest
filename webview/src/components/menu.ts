import type { CodiconName } from '../lib/codicons';
import type { Tone } from './tone';

/** One item of a MenuButton's menu. */
export interface MenuItem<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly icon?: CodiconName;
  readonly disabled?: boolean;
  /** Starts a new group: a line is drawn above the item. */
  readonly separated?: boolean;
}

/** One line of a right-click menu; `children` makes it a submenu. */
export interface ContextEntry<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly icon?: CodiconName;
  /** Colours the icon, so the kinds of action read apart at a glance. */
  readonly tone?: Tone;
  readonly disabled?: boolean;
  /** The key that does the same, shown at the right. */
  readonly keys?: string;
  /** Starts a new group: a line is drawn above the entry. */
  readonly separated?: boolean;
  readonly children?: readonly ContextEntry<Id>[];
}
