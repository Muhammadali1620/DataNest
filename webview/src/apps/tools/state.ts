// What the Tools page remembers while its editor tab is hidden. VS Code unloads a hidden
// webview and loads the page anew on show, so the page keeps its choices (tab, inputs) in
// the webview state, which the editor hands back on the next load (ARCHITECTURE.md D21).

import { getContext, setContext } from 'svelte';

/** The two calls of the editor's webview API the page needs. */
export interface StateApi {
  getState(): unknown;
  setState(state: unknown): void;
}

/** A value the page may keep: plain JSON, nothing the user did not type or pick. */
export type Remembered = string | number | boolean;

export interface ToolsState {
  /** The remembered value of `key`, or the fallback when none (or of another kind). */
  get(key: string, fallback: string): string;
  get(key: string, fallback: number): number;
  get(key: string, fallback: boolean): boolean;
  set(key: string, value: Remembered): void;
}

const ROOT = 'datanestTools';
const MAX_KEYS = 200;
const MAX_TEXT = 2000;

function readAll(api: StateApi | undefined): Map<string, Remembered> {
  const values = new Map<string, Remembered>();
  let raw: unknown;
  try {
    raw = api?.getState();
  } catch {
    return values;
  }
  const bag =
    typeof raw === 'object' && raw !== null && ROOT in raw
      ? (raw as Record<string, unknown>)[ROOT]
      : undefined;
  if (typeof bag !== 'object' || bag === null) {
    return values;
  }
  for (const [key, value] of Object.entries(bag)) {
    if (values.size >= MAX_KEYS) {
      break;
    }
    if (
      (typeof value === 'string' && value.length <= MAX_TEXT) ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      values.set(key, value);
    }
  }
  return values;
}

/** A store over the editor's state; without an API (tests, a browser) it only lives in memory. */
export function createToolsState(api?: StateApi): ToolsState {
  const values = readAll(api);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    timer = undefined;
    try {
      api?.setState({ [ROOT]: Object.fromEntries(values) });
    } catch {
      // A state that cannot be saved only costs the user a re-pick on the next load.
    }
  };
  return {
    get: ((key: string, fallback: Remembered): Remembered => {
      const value = values.get(key);
      return value !== undefined && typeof value === typeof fallback ? value : fallback;
    }) as ToolsState['get'],
    set: (key, value) => {
      if (values.get(key) === value || (typeof value === 'string' && value.length > MAX_TEXT)) {
        return;
      }
      if (values.size >= MAX_KEYS && !values.has(key)) {
        return;
      }
      values.set(key, value);
      // One write for a burst of typing.
      timer ??= setTimeout(flush, 150);
    },
  };
}

const KEY = Symbol('datanest.tools.state');

export function provideToolsState(state: ToolsState): void {
  setContext(KEY, state);
}

/** The page's store; a component rendered alone (a test) gets a throwaway one. */
export function useToolsState(): ToolsState {
  return getContext<ToolsState | undefined>(KEY) ?? createToolsState();
}
