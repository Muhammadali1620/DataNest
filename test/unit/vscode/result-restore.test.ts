import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const editorsChanged: (() => void)[] = [];
const renamed: ((event: { files: { oldUri: unknown; newUri: unknown }[] }) => void)[] = [];
const state = {
  visible: [] as { document: { languageId: string; uri: { toString(): string } } }[],
};

vi.mock('vscode', () => ({
  window: {
    get visibleTextEditors() {
      return state.visible;
    },
    onDidChangeVisibleTextEditors: (listener: () => void) => {
      editorsChanged.push(listener);
      return { dispose: () => editorsChanged.splice(editorsChanged.indexOf(listener), 1) };
    },
  },
  workspace: {
    onDidRenameFiles: (listener: (typeof renamed)[number]) => {
      renamed.push(listener);
      return { dispose: () => renamed.splice(renamed.indexOf(listener), 1) };
    },
  },
  Disposable: {
    from: (...items: { dispose(): unknown }[]) => ({
      dispose: () => {
        for (const item of items) {
          item.dispose();
        }
      },
    }),
  },
}));

import {
  INITIAL_DELAY_MS,
  registerResultRestore,
  type ResultRestoreDeps,
} from '../../../src/vscode/result-restore';
import {
  ResultMemory,
  ResultRestorer,
  type RememberRules,
} from '../../../src/services/result-memory';
import { ResultStore } from '../../../src/services/result-store';
import { FakeMemento, RecordingLogger } from '../../helpers/fakes';

const FILE = 'file:///work/report.sql';
const TARGET = { connectionId: 'c1' };
const RULES: RememberRules = { isReadOnly: () => true };

function editor(uri: string, languageId = 'sql') {
  return { document: { languageId, uri: { toString: () => uri } } };
}

async function setup(options: { enabled?: boolean; remembered?: boolean } = {}) {
  const memory = new ResultMemory(new FakeMemento());
  if (options.remembered !== false) {
    await memory.remember(FILE, [
      { statement: 'SELECT 1', statementStart: 0, pinned: false, target: TARGET },
    ]);
  }
  const results = new ResultStore();
  const shown: string[] = [];
  const listeners = new Set<() => void>();
  const deps: ResultRestoreDeps = {
    results,
    memory,
    restorer: new ResultRestorer({
      memory,
      results,
      connectionOf: () => ({ disabled: false, production: false }),
      rules: RULES,
      autoRun: () => false,
    }),
    rules: RULES,
    enabled: () => options.enabled !== false,
    showResults: (uri) => shown.push(uri),
    onConnectionsChanged: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    logger: new RecordingLogger(),
  };
  return { deps, results, memory, shown, listeners };
}

beforeEach(() => {
  vi.useFakeTimers();
  state.visible = [];
  editorsChanged.length = 0;
  renamed.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('registerResultRestore', () => {
  it('looks at the editors open at start-up a moment after, and shows the tabs', async () => {
    const { deps, results, shown } = await setup();
    state.visible = [editor(FILE)];
    registerResultRestore(deps);
    expect(shown).toEqual([]);
    vi.advanceTimersByTime(INITIAL_DELAY_MS + 1);
    expect(shown).toEqual([FILE]);
    expect(results.forDocument(FILE)[0]).toMatchObject({ restored: true, statement: 'SELECT 1' });
  });

  it('restores a file when its editor appears later', async () => {
    const { deps, shown } = await setup();
    registerResultRestore(deps);
    vi.advanceTimersByTime(INITIAL_DELAY_MS + 1);
    expect(shown).toEqual([]);
    state.visible = [editor(FILE)];
    for (const listener of editorsChanged) {
      listener();
    }
    expect(shown).toEqual([FILE]);
  });

  it('opens the panel once: a second look finds the tabs already there', async () => {
    const { deps, shown } = await setup();
    state.visible = [editor(FILE)];
    registerResultRestore(deps);
    for (const listener of editorsChanged) {
      listener();
      listener();
    }
    expect(shown).toEqual([FILE]);
  });

  it('ignores editors of other languages and files that remember nothing', async () => {
    const { deps, shown } = await setup();
    state.visible = [editor(FILE, 'markdown'), editor('file:///other.sql')];
    registerResultRestore(deps);
    vi.advanceTimersByTime(INITIAL_DELAY_MS + 1);
    expect(shown).toEqual([]);
  });

  it('does nothing while the setting is off', async () => {
    const { deps, shown, results } = await setup({ enabled: false });
    state.visible = [editor(FILE)];
    registerResultRestore(deps);
    vi.advanceTimersByTime(INITIAL_DELAY_MS + 1);
    for (const listener of editorsChanged) {
      listener();
    }
    expect(shown).toEqual([]);
    expect(results.size).toBe(0);
  });

  it('looks again when the connections change, as project connections arrive late', async () => {
    const { deps, shown, listeners } = await setup();
    registerResultRestore(deps);
    state.visible = [editor(FILE)];
    for (const listener of listeners) {
      listener();
    }
    expect(shown).toEqual([FILE]);
  });

  it('keeps the memory in step with the results', async () => {
    const { deps, results, memory } = await setup({ remembered: false });
    registerResultRestore(deps);
    results.add({
      documentUri: FILE,
      statement: 'SELECT 5',
      statementStart: 0,
      columns: [],
      rows: [],
      truncated: false,
      durationMs: 1,
      origin: { target: TARGET, owner: 'o' },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(memory.get(FILE).map((tab) => tab.statement)).toEqual(['SELECT 5']);
  });

  it('moves the tabs with a renamed file', async () => {
    const { deps, memory } = await setup();
    registerResultRestore(deps);
    const to = 'file:///work/renamed.sql';
    for (const listener of renamed) {
      listener({ files: [{ oldUri: { toString: () => FILE }, newUri: { toString: () => to } }] });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(memory.get(FILE)).toEqual([]);
    expect(memory.get(to)).toHaveLength(1);
  });

  it('stops listening and cancels the first look when disposed', async () => {
    const { deps, shown, listeners } = await setup();
    state.visible = [editor(FILE)];
    registerResultRestore(deps).dispose();
    vi.advanceTimersByTime(INITIAL_DELAY_MS + 1);
    expect(shown).toEqual([]);
    expect(editorsChanged).toHaveLength(0);
    expect(renamed).toHaveLength(0);
    expect(listeners.size).toBe(0);
  });
});
