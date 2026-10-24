/** Same shape as `vscode.Disposable`, so instances go straight into `context.subscriptions`. */
export interface Disposable {
  dispose(): void;
}

/** Wraps a cleanup function; it runs at most once. */
export function toDisposable(cleanup: () => void): Disposable {
  let done = false;
  return {
    dispose: () => {
      if (!done) {
        done = true;
        cleanup();
      }
    },
  };
}

/**
 * Owns a set of disposables and releases them in reverse order of adding.
 * Every item is disposed even if some of them throw; the errors are rethrown afterwards.
 */
export class DisposableStore implements Disposable {
  private items: Disposable[] = [];
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  get size(): number {
    return this.items.length;
  }

  /** Adds an item; if the store is already disposed, the item is disposed right away. */
  add<T extends Disposable>(item: T): T {
    if (this.disposed) {
      item.dispose();
    } else {
      this.items.push(item);
    }
    return item;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const items = this.items.reverse();
    this.items = [];
    const errors: unknown[] = [];
    for (const item of items) {
      try {
        item.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} disposables failed`);
    }
  }
}
