import { describe, expect, it, vi } from 'vitest';
import { scopedRpc } from '../../../../webview/src/lib/scoped-rpc';

function fakePeer() {
  const listeners = new Map<string, (payload: unknown) => void>();
  return {
    listeners,
    request: vi.fn((_method: string, params: unknown) => Promise.resolve({ echoed: params })),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      listeners.set(event, listener);
      return { dispose: () => listeners.delete(event) };
    }),
    emit: vi.fn(),
  };
}

describe('scopedRpc', () => {
  it('asks under the prefix and returns the answer', async () => {
    const peer = fakePeer();
    const scoped = scopedRpc(peer, 'monitor') as unknown as {
      request(method: string, params: unknown): Promise<unknown>;
    };
    await expect(scoped.request('stop', { id: '7' })).resolves.toEqual({ echoed: { id: '7' } });
    expect(peer.request).toHaveBeenCalledWith('monitor.stop', { id: '7' });
  });

  it('hears the events of its prefix only, and stops listening when told', () => {
    const peer = fakePeer();
    const scoped = scopedRpc(peer, 'compare') as unknown as {
      on(event: string, listener: (payload: unknown) => void): { dispose(): void };
    };
    const seen = vi.fn();
    const subscription = scoped.on('state', seen);
    expect(peer.on).toHaveBeenCalledWith('compare.state', seen);
    peer.listeners.get('compare.state')?.({ items: [] });
    expect(seen).toHaveBeenCalledWith({ items: [] });
    subscription.dispose();
    expect(peer.listeners.has('compare.state')).toBe(false);
  });

  it('emits under the prefix', () => {
    const peer = fakePeer();
    const scoped = scopedRpc(peer, 'compare') as unknown as {
      emit(event: string, payload: unknown): void;
    };
    scoped.emit('swap', {});
    expect(peer.emit).toHaveBeenCalledWith('compare.swap', {});
  });

  it('can be disposed without touching the real peer', () => {
    const peer = fakePeer();
    const scoped = scopedRpc(peer, 'x') as unknown as { dispose(): void };
    expect(() => {
      scoped.dispose();
    }).not.toThrow();
  });
});
