import type * as vscode from 'vscode';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearOffer,
  guardPanel,
  hasOfferedPanel,
  isGuarded,
  offerPanel,
  releasePanel,
  takeOffer,
} from '../../../../src/vscode/panels/panel-handoff';

/** A stand-in for the editor tab with the parts a page uses. */
function fakeTab() {
  const closeListeners: (() => void)[] = [];
  const messageListeners: ((message: unknown) => void)[] = [];
  const viewListeners: ((event: unknown) => void)[] = [];
  const posted: unknown[] = [];
  const tab = {
    title: 'Table',
    iconPath: undefined as unknown,
    viewColumn: 2,
    disposed: 0,
    revealed: 0,
    webview: {
      html: '<p>old</p>',
      options: {},
      cspSource: 'csp',
      asWebviewUri: (uri: unknown) => uri,
      postMessage: (message: unknown) => {
        posted.push(message);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (listener: (message: unknown) => void) => {
        messageListeners.push(listener);
        return { dispose: () => messageListeners.splice(messageListeners.indexOf(listener), 1) };
      },
    },
    dispose() {
      tab.disposed += 1;
      for (const listener of [...closeListeners]) {
        listener();
      }
    },
    reveal() {
      tab.revealed += 1;
    },
    onDidDispose: (listener: () => void) => {
      closeListeners.push(listener);
      return { dispose: () => closeListeners.splice(closeListeners.indexOf(listener), 1) };
    },
    onDidChangeViewState: (listener: (event: unknown) => void) => {
      viewListeners.push(listener);
      return { dispose: () => viewListeners.splice(viewListeners.indexOf(listener), 1) };
    },
  };
  return { tab, posted, messageListeners, viewListeners };
}

const asPanel = (tab: object): vscode.WebviewPanel => tab as unknown as vscode.WebviewPanel;

afterEach(clearOffer);

describe('guardPanel', () => {
  it('passes everything through while the page owns the tab', async () => {
    const { tab, posted } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    expect(guard.viewColumn).toBe(2);
    guard.title = 'Properties';
    guard.webview.html = '<p>new</p>';
    guard.reveal();
    await guard.webview.postMessage({ type: 'x' });
    expect(tab.title).toBe('Properties');
    expect(tab.webview.html).toBe('<p>new</p>');
    expect(tab.revealed).toBe(1);
    expect(posted).toEqual([{ type: 'x' }]);
    expect(guard.webview.cspSource).toBe('csp');
    expect(guard.webview.options).toEqual({});
    expect(isGuarded(guard)).toBe(true);
  });

  it('closes the tab on dispose and tells the page', () => {
    const { tab } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    const closed = vi.fn();
    guard.onDidDispose(closed);
    guard.dispose();
    expect(tab.disposed).toBe(1);
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('delivers messages and view-state changes to the page', () => {
    const { tab, messageListeners, viewListeners } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    const message = vi.fn();
    const view = vi.fn();
    guard.webview.onDidReceiveMessage(message);
    guard.onDidChangeViewState(view);
    messageListeners[0]?.({ a: 1 });
    viewListeners[0]?.({ b: 2 });
    expect(message).toHaveBeenCalledWith({ a: 1 });
    expect(view).toHaveBeenCalledWith({ b: 2 });
  });

  it('stops listening once a listener is disposed', () => {
    const { tab } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    const closed = vi.fn();
    guard.onDidDispose(closed).dispose();
    tab.dispose();
    expect(closed).not.toHaveBeenCalled();
  });
});

describe('releasePanel', () => {
  it('hands the tab on without closing it and lets the old page dispose itself', () => {
    const { tab } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    const closed = vi.fn(() => {
      // What every page does when its tab closes.
      guard.dispose();
    });
    guard.onDidDispose(closed);
    const real = releasePanel(guard);
    expect(real).toBe(tab);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(tab.disposed).toBe(0);
    expect(isGuarded(guard)).toBe(false);
  });

  it('cuts the old page off: no title, icon, html, reveal, messages or view state', async () => {
    const { tab, posted, messageListeners, viewListeners } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    const message = vi.fn();
    const view = vi.fn();
    guard.webview.onDidReceiveMessage(message);
    guard.onDidChangeViewState(view);
    releasePanel(guard);
    // The new page now owns the tab.
    tab.title = 'New page';
    guard.title = 'Old page again';
    guard.iconPath = 'old-icon' as never;
    guard.webview.html = '<p>old</p>';
    guard.reveal();
    expect(await guard.webview.postMessage({ stale: true })).toBe(false);
    expect(tab.title).toBe('New page');
    expect(tab.iconPath).toBeUndefined();
    expect(tab.webview.html).toBe('<p>old</p>');
    expect(tab.revealed).toBe(0);
    expect(posted).toEqual([]);
    expect(messageListeners).toHaveLength(0);
    expect(viewListeners).toHaveLength(0);
    expect(message).not.toHaveBeenCalled();
    expect(view).not.toHaveBeenCalled();
    // New listeners of a dead guard are inert.
    guard.onDidDispose(vi.fn()).dispose();
    guard.webview.onDidReceiveMessage(vi.fn()).dispose();
    guard.onDidChangeViewState(vi.fn()).dispose();
  });

  it('does not run the old close listeners again when the tab really closes', () => {
    const { tab } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    const closed = vi.fn();
    guard.onDidDispose(closed);
    releasePanel(guard);
    tab.dispose();
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('lets the next page guard the same tab and hand it on again', () => {
    const { tab } = fakeTab();
    const first = guardPanel(asPanel(tab));
    releasePanel(first);
    const second = guardPanel(asPanel(tab));
    const closed = vi.fn();
    second.onDidDispose(closed);
    expect(releasePanel(second)).toBe(tab);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(tab.disposed).toBe(0);
  });

  it('refuses a panel it does not guard and a guard already released', () => {
    const { tab } = fakeTab();
    expect(releasePanel(asPanel(tab))).toBeUndefined();
    const guard = guardPanel(asPanel(tab));
    expect(releasePanel(guard)).toBe(tab);
    expect(releasePanel(guard)).toBeUndefined();
  });
});

describe('the tab on offer', () => {
  it('is taken once, and taking it releases the page that gave it up', () => {
    const { tab } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    const closed = vi.fn();
    guard.onDidDispose(closed);
    expect(offerPanel(guard, 'er-diagram')).toBe(true);
    expect(hasOfferedPanel()).toBe(true);
    expect(takeOffer('er-diagram')).toEqual({ panel: tab, bar: undefined });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(hasOfferedPanel()).toBe(false);
    expect(takeOffer('er-diagram')).toBeUndefined();
  });

  it('carries what the new page is told about its place in the table', () => {
    const { tab } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    offerPanel(guard, 'er-diagram', { page: 'er', isView: false });
    expect(takeOffer('er-diagram')).toEqual({ panel: tab, bar: { page: 'er', isView: false } });
  });

  it('is not taken by a page of another app, which leaves it waiting for the right one', () => {
    const { tab } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    const closed = vi.fn();
    guard.onDidDispose(closed);
    offerPanel(guard, 'er-diagram');
    // The user opened something else while the target still asked its question.
    expect(takeOffer('tools')).toBeUndefined();
    expect(hasOfferedPanel()).toBe(true);
    expect(closed).not.toHaveBeenCalled();
    expect(takeOffer('er-diagram')?.panel).toBe(tab);
  });

  it('can be withdrawn, and then the old page keeps its tab', () => {
    const { tab } = fakeTab();
    const guard = guardPanel(asPanel(tab));
    const closed = vi.fn();
    guard.onDidDispose(closed);
    offerPanel(guard, 'er-diagram');
    clearOffer();
    expect(takeOffer('er-diagram')).toBeUndefined();
    expect(closed).not.toHaveBeenCalled();
    expect(isGuarded(guard)).toBe(true);
  });

  it('is not made for a panel that is not guarded or was already given away', () => {
    const { tab } = fakeTab();
    expect(offerPanel(asPanel(tab), 'er-diagram')).toBe(false);
    const guard = guardPanel(asPanel(tab));
    releasePanel(guard);
    expect(offerPanel(guard, 'er-diagram')).toBe(false);
    expect(hasOfferedPanel()).toBe(false);
  });
});
