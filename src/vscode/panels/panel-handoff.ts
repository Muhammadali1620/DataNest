// One tab for all the pages of a table (D117). A page that hands the user over to another
// page of the same table (the bar: data, properties, ER diagram…) offers its editor tab;
// the next page created takes that very tab and loads its own content into it. The tab
// never closes and never moves, so there is no flash of a closing and an opening window,
// and the old page stays alive and usable until the new one is about to appear.
//
// Every page holds its panel through a guard. Once the tab is handed on, the guard turns
// dead for the page that gave it up: its `dispose` no longer closes the tab, its title,
// icon and messages no longer reach it, and its own close listeners run (that is how it
// lets go of its sessions and open-page registry).

import type * as vscode from 'vscode';

interface GuardState {
  released: boolean;
  readonly real: vscode.WebviewPanel;
  readonly closeListeners: Set<() => void>;
  readonly detachables: Set<vscode.Disposable>;
}

const states = new WeakMap<object, GuardState>();

const NO_DISPOSABLE: vscode.Disposable = { dispose: () => undefined };

/** A view of the page's webview that stops working once the tab has been handed on. */
function guardWebview(state: GuardState): vscode.Webview {
  const live = (): vscode.Webview => state.real.webview;
  const track = (disposable: vscode.Disposable): vscode.Disposable => {
    state.detachables.add(disposable);
    return {
      dispose: () => {
        state.detachables.delete(disposable);
        disposable.dispose();
      },
    };
  };
  return {
    get html() {
      return live().html;
    },
    set html(value: string) {
      if (!state.released) {
        live().html = value;
      }
    },
    get options() {
      return live().options;
    },
    set options(value: vscode.WebviewOptions) {
      if (!state.released) {
        live().options = value;
      }
    },
    get cspSource() {
      return live().cspSource;
    },
    asWebviewUri: (uri: vscode.Uri) => live().asWebviewUri(uri),
    postMessage: async (message: unknown) =>
      state.released ? false : await live().postMessage(message),
    onDidReceiveMessage: (listener: (message: unknown) => unknown, thisArg?: unknown) => {
      if (state.released) {
        return NO_DISPOSABLE;
      }
      return track(
        live().onDidReceiveMessage((message: unknown) => {
          if (!state.released) {
            listener.call(thisArg, message);
          }
        }),
      );
    },
  };
}

/**
 * Wraps a freshly made (or handed-on) editor tab for one page. Reads and calls go to the
 * tab; after `releasePanel` they are ignored.
 */
export function guardPanel(real: vscode.WebviewPanel): vscode.WebviewPanel {
  const state: GuardState = {
    released: false,
    real,
    closeListeners: new Set(),
    detachables: new Set(),
  };
  const webview = guardWebview(state);
  const guard = new Proxy(real, {
    get(target, property) {
      switch (property) {
        case 'webview':
          return webview;
        case 'dispose':
          return () => {
            if (!state.released) {
              target.dispose();
            }
          };
        case 'reveal':
          return (...args: Parameters<vscode.WebviewPanel['reveal']>) => {
            if (!state.released) {
              target.reveal(...args);
            }
          };
        case 'onDidDispose':
          return (listener: () => unknown, thisArg?: unknown) => {
            if (state.released) {
              return NO_DISPOSABLE;
            }
            const wrapped = (): void => {
              listener.call(thisArg);
            };
            state.closeListeners.add(wrapped);
            const subscription = target.onDidDispose(() => {
              if (state.closeListeners.delete(wrapped)) {
                wrapped();
              }
            });
            return {
              dispose: () => {
                state.closeListeners.delete(wrapped);
                subscription.dispose();
              },
            };
          };
        case 'onDidChangeViewState':
          return (listener: (event: unknown) => unknown, thisArg?: unknown) => {
            if (state.released) {
              return NO_DISPOSABLE;
            }
            const subscription = target.onDidChangeViewState((event) => {
              if (!state.released) {
                listener.call(thisArg, event);
              }
            });
            state.detachables.add(subscription);
            return subscription;
          };
        default: {
          const value: unknown = Reflect.get(target, property, target);
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        }
      }
    },
    set(target, property, value) {
      // A page that gave the tab up must not rename or re-icon the page that took it.
      if (state.released) {
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
  });
  states.set(guard, state);
  return guard;
}

/**
 * Takes the tab away from the page that holds `guard`: marks the guard dead first, then
 * runs the close listeners of that page (so it disposes itself without closing the tab).
 * Returns the tab, or undefined for a panel that is not guarded.
 */
export function releasePanel(guard: vscode.WebviewPanel): vscode.WebviewPanel | undefined {
  const state = states.get(guard);
  if (state === undefined || state.released) {
    return undefined;
  }
  state.released = true;
  for (const detachable of [...state.detachables]) {
    detachable.dispose();
  }
  state.detachables.clear();
  for (const listener of [...state.closeListeners]) {
    state.closeListeners.delete(listener);
    listener();
  }
  return state.real;
}

/** True for a panel that was made by `guardPanel` and still belongs to its page. */
export function isGuarded(panel: vscode.WebviewPanel): boolean {
  const state = states.get(panel);
  return state !== undefined && !state.released;
}

/** What the page that takes the tab is told about its place in the table (see the bar). */
export interface OfferedBar {
  readonly page: string;
  readonly isView: boolean;
}

interface Offer {
  readonly guard: vscode.WebviewPanel;
  /** The page (webview app) that may take the tab: no other page does. */
  readonly app: string;
  readonly bar: OfferedBar | undefined;
}

let offered: Offer | undefined;

/**
 * Offers the tab of a page to the next page of `app` that gets created. A page of another
 * app (the user opened something else while the target was still asking a question) does
 * not take it.
 */
export function offerPanel(guard: vscode.WebviewPanel, app: string, bar?: OfferedBar): boolean {
  if (!isGuarded(guard)) {
    return false;
  }
  offered = { guard, app, bar };
  return true;
}

/** True while an offered tab waits for the page that is to take it. */
export function hasOfferedPanel(): boolean {
  return offered !== undefined;
}

export function clearOffer(): void {
  offered = undefined;
}

/** The tab on offer to a page of `app`, once: taking it releases the page that gave it up. */
export function takeOffer(
  app: string,
): { panel: vscode.WebviewPanel; bar: OfferedBar | undefined } | undefined {
  const offer = offered;
  if (offer?.app !== app) {
    return undefined;
  }
  offered = undefined;
  const panel = releasePanel(offer.guard);
  return panel === undefined ? undefined : { panel, bar: offer.bar };
}
