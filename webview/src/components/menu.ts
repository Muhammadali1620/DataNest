import type { CodiconName } from '../lib/codicons';

/** One item of a MenuButton's menu. */
export interface MenuItem<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly icon?: CodiconName;
  readonly disabled?: boolean;
  /** Starts a new group: a line is drawn above the item. */
  readonly separated?: boolean;
}
