// Auto-commit or manual commit, per SQL document (V4.8). Free of `vscode`: documents
// are named by their URI, and the default comes from the settings through a function.

import { type Disposable, toDisposable } from '../../core/disposable';

export const TRANSACTION_MODES = ['auto', 'manual'] as const;

export type TransactionMode = (typeof TRANSACTION_MODES)[number];

export function isTransactionMode(value: unknown): value is TransactionMode {
  return value === 'auto' || value === 'manual';
}

/**
 * The mode the user picked for a document, or the default from the settings for one
 * where they did not; changing the setting moves every document without a choice.
 */
export class TransactionModes {
  private readonly chosen = new Map<string, TransactionMode>();
  private readonly listeners = new Set<(documentUri: string) => void>();

  constructor(private readonly defaultMode: () => TransactionMode) {}

  modeOf(documentUri: string): TransactionMode {
    return this.chosen.get(documentUri) ?? this.defaultMode();
  }

  set(documentUri: string, mode: TransactionMode): void {
    if (this.modeOf(documentUri) === mode && this.chosen.has(documentUri)) {
      return;
    }
    this.chosen.set(documentUri, mode);
    this.notify(documentUri);
  }

  /** Flips the mode of a document and returns the new one. */
  toggle(documentUri: string): TransactionMode {
    const next = this.modeOf(documentUri) === 'auto' ? 'manual' : 'auto';
    this.set(documentUri, next);
    return next;
  }

  /** Forgets a closed document. */
  forget(documentUri: string): void {
    this.chosen.delete(documentUri);
  }

  onDidChange(listener: (documentUri: string) => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  private notify(documentUri: string): void {
    for (const listener of [...this.listeners]) {
      listener(documentUri);
    }
  }
}
