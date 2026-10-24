import type { RpcSubscription, RpcTransport } from '../../src/shared/rpc';

/** One end of an in-memory channel; records what it posted and can inject raw input. */
export class FakeTransport implements RpcTransport {
  readonly posted: unknown[] = [];
  private readonly listeners = new Set<(message: unknown) => void>();
  peer: FakeTransport | undefined;

  post(message: unknown): void {
    this.posted.push(message);
    // Like postMessage: asynchronous and structured-cloned.
    const copy = structuredClone(message);
    const target = this.peer;
    queueMicrotask(() => {
      target?.deliver(copy);
    });
  }

  subscribe(listener: (message: unknown) => void): RpcSubscription {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Simulates a message arriving from the other side (possibly malformed). */
  deliver(message: unknown): void {
    for (const listener of [...this.listeners]) {
      listener(message);
    }
  }

  get listenerCount(): number {
    return this.listeners.size;
  }
}

export function createLinkedTransports(): { host: FakeTransport; webview: FakeTransport } {
  const host = new FakeTransport();
  const webview = new FakeTransport();
  host.peer = webview;
  webview.peer = host;
  return { host, webview };
}

/** Lets queued microtasks (message deliveries and async handlers) run. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}
