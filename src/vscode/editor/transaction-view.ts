// What the status bar says about the transaction of the SQL document in front of the
// user (V4.8). Free of `vscode`, so every state and its wording is a unit test.

import type { TransactionState } from '../../drivers/driver';
import type { TransactionMode } from './transaction-modes';

export interface TransactionTexts {
  readonly auto: string;
  readonly manual: string;
  readonly open: string;
  readonly failed: string;
  readonly autoTooltip: string;
  readonly manualTooltip: string;
  readonly openTooltip: string;
  readonly failedTooltip: string;
}

export interface TransactionView {
  readonly text: string;
  readonly tooltip: string;
  /** `warning` while changes wait for a decision, `error` once the transaction failed. */
  readonly tone: 'normal' | 'warning' | 'error';
  /** Which of the Commit and Rollback items to show. */
  readonly commit: boolean;
  readonly rollback: boolean;
}

/**
 * The mode while nothing is pending; a transaction, open or failed, outranks the
 * mode, because that is what the user must act on.
 */
export function transactionView(
  mode: TransactionMode,
  state: TransactionState | undefined,
  texts: TransactionTexts,
): TransactionView {
  if (state === 'open') {
    return {
      text: texts.open,
      tooltip: texts.openTooltip,
      tone: 'warning',
      commit: true,
      rollback: true,
    };
  }
  if (state === 'failed') {
    return {
      text: texts.failed,
      tooltip: texts.failedTooltip,
      tone: 'error',
      commit: false,
      rollback: true,
    };
  }
  return mode === 'manual'
    ? {
        text: texts.manual,
        tooltip: texts.manualTooltip,
        tone: 'normal',
        commit: false,
        rollback: false,
      }
    : {
        text: texts.auto,
        tooltip: texts.autoTooltip,
        tone: 'normal',
        commit: false,
        rollback: false,
      };
}
