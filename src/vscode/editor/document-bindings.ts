// Which connection (and database) each SQL document talks to. Free of `vscode`:
// documents are identified by their URI as a string.

import { type Disposable, toDisposable } from '../../core/disposable';
import type { SessionTarget } from '../../services/connection-manager';

export type DocumentBinding = SessionTarget;

/**
 * Bindings live for as long as the editor session: an untitled query keeps its
 * connection while it is open, and closing the document drops the binding.
 */
export class DocumentBindings {
  private readonly bindings = new Map<string, DocumentBinding>();
  private readonly listeners = new Set<(documentUri: string) => void>();

  get size(): number {
    return this.bindings.size;
  }

  get(documentUri: string): DocumentBinding | undefined {
    return this.bindings.get(documentUri);
  }

  /** Documents currently bound, in the order they were first bound. */
  documents(): string[] {
    return [...this.bindings.keys()];
  }

  /** Points a document at a connection; an unchanged binding fires no event. */
  bind(documentUri: string, binding: DocumentBinding): void {
    const current = this.bindings.get(documentUri);
    if (current?.connectionId === binding.connectionId && current?.database === binding.database) {
      return;
    }
    this.bindings.set(documentUri, {
      connectionId: binding.connectionId,
      ...(binding.database === undefined ? {} : { database: binding.database }),
    });
    this.notify(documentUri);
  }

  /** Forgets a document, e.g. when it is closed. Unknown documents are ignored. */
  unbind(documentUri: string): void {
    if (this.bindings.delete(documentUri)) {
      this.notify(documentUri);
    }
  }

  /** Forgets every document bound to a connection; returns the ones it dropped. */
  unbindConnection(connectionId: string): string[] {
    const dropped = [...this.bindings.entries()]
      .filter(([, binding]) => binding.connectionId === connectionId)
      .map(([documentUri]) => documentUri);
    for (const documentUri of dropped) {
      this.unbind(documentUri);
    }
    return dropped;
  }

  /** Fires with the document whose binding changed, was added or was removed. */
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
