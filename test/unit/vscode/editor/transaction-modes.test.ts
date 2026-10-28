import { describe, expect, it, vi } from 'vitest';
import {
  isTransactionMode,
  TransactionModes,
} from '../../../../src/vscode/editor/transaction-modes';

describe('TransactionModes', () => {
  it('uses the default until a document is switched, and follows a new default', () => {
    let fallback: 'auto' | 'manual' = 'auto';
    const modes = new TransactionModes(() => fallback);
    expect(modes.modeOf('a')).toBe('auto');
    fallback = 'manual';
    expect(modes.modeOf('a')).toBe('manual');
  });

  it('keeps a choice per document and tells listeners', () => {
    const modes = new TransactionModes(() => 'auto');
    const seen = vi.fn();
    modes.onDidChange(seen);
    expect(modes.toggle('a')).toBe('manual');
    expect(modes.modeOf('a')).toBe('manual');
    expect(modes.modeOf('b')).toBe('auto');
    expect(modes.toggle('a')).toBe('auto');
    expect(seen.mock.calls).toEqual([['a'], ['a']]);
  });

  it('remembers an explicit choice that equals the default, so a new default does not move it', () => {
    let fallback: 'auto' | 'manual' = 'auto';
    const modes = new TransactionModes(() => fallback);
    const seen = vi.fn();
    modes.onDidChange(seen);
    modes.set('a', 'auto');
    modes.set('a', 'auto');
    fallback = 'manual';
    expect(modes.modeOf('a')).toBe('auto');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('forgets a closed document and stops telling a disposed listener', () => {
    const modes = new TransactionModes(() => 'auto');
    const seen = vi.fn();
    const subscription = modes.onDidChange(seen);
    modes.set('a', 'manual');
    modes.forget('a');
    expect(modes.modeOf('a')).toBe('auto');
    subscription.dispose();
    modes.set('a', 'manual');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('recognizes the two modes only', () => {
    expect(isTransactionMode('auto')).toBe(true);
    expect(isTransactionMode('manual')).toBe(true);
    expect(isTransactionMode('Manual')).toBe(false);
    expect(isTransactionMode(undefined)).toBe(false);
  });
});
