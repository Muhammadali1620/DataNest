import { describe, expect, it } from 'vitest';
import {
  type TransactionTexts,
  transactionView,
} from '../../../../src/vscode/editor/transaction-view';

const TEXTS: TransactionTexts = {
  auto: 'Auto',
  manual: 'Manual',
  open: 'Open',
  failed: 'Failed',
  autoTooltip: 'auto tip',
  manualTooltip: 'manual tip',
  openTooltip: 'open tip',
  failedTooltip: 'failed tip',
};

describe('transactionView', () => {
  it('shows the mode while nothing is pending, with no buttons', () => {
    for (const state of ['idle', undefined] as const) {
      expect(transactionView('auto', state, TEXTS)).toEqual({
        text: 'Auto',
        tooltip: 'auto tip',
        tone: 'normal',
        commit: false,
        rollback: false,
      });
      expect(transactionView('manual', state, TEXTS)).toMatchObject({
        text: 'Manual',
        tooltip: 'manual tip',
        tone: 'normal',
      });
    }
  });

  it('puts an open transaction first, in the warning color, with both buttons', () => {
    for (const mode of ['auto', 'manual'] as const) {
      expect(transactionView(mode, 'open', TEXTS)).toEqual({
        text: 'Open',
        tooltip: 'open tip',
        tone: 'warning',
        commit: true,
        rollback: true,
      });
    }
  });

  it('offers only Rollback for a failed transaction, in the error color', () => {
    expect(transactionView('manual', 'failed', TEXTS)).toEqual({
      text: 'Failed',
      tooltip: 'failed tip',
      tone: 'error',
      commit: false,
      rollback: true,
    });
  });
});
