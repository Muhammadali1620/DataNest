import { describe, expect, it } from 'vitest';
import {
  durationProblem,
  type LokiCommandDeps,
  type LokiEditor,
  lokiCommandHandlers,
  RANGE_CHOICES,
} from '../../../../src/vscode/loki/loki-commands';

interface Rig {
  readonly deps: LokiCommandDeps;
  readonly warnings: string[];
  readonly picks: { title: string; choices: readonly string[]; current: string | undefined }[];
  text: string;
}

function rig(
  options: {
    text?: string;
    driver?: string | null;
    editor?: boolean;
    pick?: string | undefined;
    typed?: string | undefined;
  } = {},
): Rig {
  const state: Rig = {
    warnings: [],
    picks: [],
    text: options.text ?? '{app="shop"}',
    deps: undefined as unknown as LokiCommandDeps,
  };
  const editor: LokiEditor = {
    uri: 'file:///q.sql',
    get text() {
      return state.text;
    },
    replaceText: (text) => {
      state.text = text;
      return Promise.resolve();
    },
  };
  const deps: LokiCommandDeps = {
    store: {
      get: () =>
        options.driver === null
          ? undefined
          : ({ id: 'c', driver: options.driver ?? 'loki' } as never),
    },
    bindings: {
      get: () => (options.driver === null ? undefined : { connectionId: 'c' }),
    },
    activeEditor: () => (options.editor === false ? undefined : editor),
    ui: {
      pick: (title, choices, current) => {
        state.picks.push({ title, choices, current });
        return Promise.resolve(options.pick);
      },
      inputDuration: (_title, _prompt, check) => {
        // The check runs on what the user types, as the input box does.
        if (options.typed !== undefined) {
          expect(typeof check(options.typed)).toMatch(/string|undefined/u);
        }
        return Promise.resolve(options.typed);
      },
      warn: (message) => state.warnings.push(message),
    },
  };
  return Object.assign(state, { deps });
}

describe('Loki editor commands', () => {
  it('writes the chosen window above the query', async () => {
    const r = rig({ pick: '6h' });
    await lokiCommandHandlers(r.deps).setRange();
    expect(r.text).toBe('# range: 6h\n{app="shop"}');
    expect(r.picks[0]?.choices.slice(0, RANGE_CHOICES.length)).toEqual([...RANGE_CHOICES]);
  });

  it('marks the window the query has now', async () => {
    const r = rig({ text: '# range: 15m\n{a="b"}', pick: '1h' });
    await lokiCommandHandlers(r.deps).setRange();
    expect(r.picks[0]?.current).toBe('15m');
    expect(r.text).toBe('# range: 1h\n{a="b"}');
  });

  it('asks for a time of one’s own and writes it trimmed', async () => {
    const other = rig();
    const handlers = lokiCommandHandlers(other.deps);
    const choices = (await handlers.setRange(), other.picks[0]?.choices ?? []);
    const custom = choices.at(-1);
    const r = rig({ pick: custom, typed: ' 2h ' });
    await lokiCommandHandlers(r.deps).setRange();
    expect(r.text).toBe('# range: 2h\n{app="shop"}');
  });

  it('changes nothing when the user backs out of either question', async () => {
    const first = rig({ pick: undefined });
    await lokiCommandHandlers(first.deps).setRange();
    expect(first.text).toBe('{app="shop"}');
    const custom = await (async () => {
      const probe = rig();
      await lokiCommandHandlers(probe.deps).follow();
      return probe.picks[0]?.choices.at(-1);
    })();
    const second = rig({ pick: custom, typed: undefined });
    await lokiCommandHandlers(second.deps).follow();
    expect(second.text).toBe('{app="shop"}');
  });

  it('writes how long to follow a query', async () => {
    const r = rig({ pick: '5m' });
    await lokiCommandHandlers(r.deps).follow();
    expect(r.text).toBe('# tail: 5m\n{app="shop"}');
    expect(r.picks[0]?.choices).toContain('10m');
  });

  it('offers a live view with no time limit', async () => {
    const r = rig({ pick: 'forever' });
    await lokiCommandHandlers(r.deps).follow();
    expect(r.text).toBe('# tail: forever\n{app="shop"}');
    expect(r.picks[0]?.choices).toContain('forever');
  });

  it('refuses an editor that is not connected to Loki', async () => {
    for (const driver of ['postgres', null] as const) {
      const r = rig({ driver, pick: '1h' });
      await lokiCommandHandlers(r.deps).setRange();
      await lokiCommandHandlers(r.deps).follow();
      expect(r.text).toBe('{app="shop"}');
      expect(r.warnings).toHaveLength(2);
      expect(r.warnings[0]).toMatch(/not connected to Grafana Loki/u);
    }
  });

  it('says so when there is no editor', async () => {
    const r = rig({ editor: false });
    await lokiCommandHandlers(r.deps).setRange();
    expect(r.warnings).toEqual(['Open a query editor first']);
  });
});

describe('durationProblem', () => {
  it('accepts a time within the limit', () => {
    expect(durationProblem('2h', 86_400_000)).toBeUndefined();
  });

  it('refuses a word, an empty text and a time above the limit', () => {
    expect(durationProblem('soon', 1000)).toMatch(/Write a time/u);
    expect(durationProblem('', 1000)).toMatch(/Write a time/u);
    expect(durationProblem('2h', 1000)).toMatch(/longer than allowed/u);
  });
});
