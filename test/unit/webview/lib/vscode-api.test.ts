import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebviewTransport } from '../../../../webview/src/lib/vscode-api';

describe('createWebviewTransport', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('posts messages through the VS Code API', () => {
    const postMessage = vi.fn();
    createWebviewTransport({ postMessage }).post({ kind: 'event', name: 'ready', payload: {} });
    expect(postMessage).toHaveBeenCalledWith({ kind: 'event', name: 'ready', payload: {} });
  });

  it('passes the data of window message events to the listener', () => {
    const listener = vi.fn();
    const subscription = createWebviewTransport({ postMessage: vi.fn() }).subscribe(listener);
    window.dispatchEvent(new MessageEvent('message', { data: { kind: 'event' } }));
    expect(listener).toHaveBeenCalledWith({ kind: 'event' });
    subscription.dispose();
    window.dispatchEvent(new MessageEvent('message', { data: 'late' }));
    expect(listener).toHaveBeenCalledOnce();
  });

  it('listens on the given target', () => {
    const target = new EventTarget();
    const listener = vi.fn();
    createWebviewTransport({ postMessage: vi.fn() }, target).subscribe(listener);
    target.dispatchEvent(new MessageEvent('message', { data: 1 }));
    window.dispatchEvent(new MessageEvent('message', { data: 2 }));
    expect(listener.mock.calls).toEqual([[1]]);
  });
});

describe('getVsCodeApi', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('acquires the API only once, as VS Code allows', async () => {
    const api = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
    const acquire = vi.fn(() => api);
    vi.stubGlobal('acquireVsCodeApi', acquire);
    const { getVsCodeApi } = await import('../../../../webview/src/lib/vscode-api');
    expect(getVsCodeApi()).toBe(api);
    expect(getVsCodeApi()).toBe(api);
    expect(acquire).toHaveBeenCalledOnce();
  });
});
