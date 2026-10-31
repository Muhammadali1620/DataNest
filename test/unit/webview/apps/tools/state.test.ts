import { afterEach, describe, expect, it, vi } from 'vitest';
import { createToolsState, type StateApi } from '../../../../../webview/src/apps/tools/state';

function api(initial?: unknown) {
  let saved: unknown = initial;
  const setState = vi.fn((next: unknown) => {
    saved = next;
  });
  const handle: StateApi = { getState: () => saved, setState };
  return { handle, setState, saved: () => saved };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createToolsState', () => {
  it('gives the fallback for what was never set', () => {
    const state = createToolsState(api().handle);
    expect(state.get('a', 'x')).toBe('x');
    expect(state.get('b', 3)).toBe(3);
    expect(state.get('c', false)).toBe(false);
  });

  it('remembers values of each kind', () => {
    const state = createToolsState();
    state.set('s', 'text');
    state.set('n', 7);
    state.set('b', true);
    expect(state.get('s', '')).toBe('text');
    expect(state.get('n', 0)).toBe(7);
    expect(state.get('b', false)).toBe(true);
  });

  it('ignores a remembered value of another kind than the one asked for', () => {
    const state = createToolsState();
    state.set('k', 5);
    expect(state.get('k', 'fallback')).toBe('fallback');
    expect(state.get('k', true)).toBe(true);
  });

  it('writes one state for a burst of changes, after a short pause', () => {
    vi.useFakeTimers();
    const { handle, setState } = api();
    const state = createToolsState(handle);
    state.set('a', '1');
    state.set('a', '12');
    state.set('b', 2);
    expect(setState).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(setState).toHaveBeenCalledOnce();
    expect(setState).toHaveBeenCalledWith({ datanestTools: { a: '12', b: 2 } });
  });

  it('writes nothing for a value that did not change', () => {
    vi.useFakeTimers();
    const { handle, setState } = api({ datanestTools: { a: 'same' } });
    const state = createToolsState(handle);
    state.set('a', 'same');
    vi.advanceTimersByTime(500);
    expect(setState).not.toHaveBeenCalled();
  });

  it('is read back by the next load of the page', () => {
    vi.useFakeTimers();
    const first = api();
    createToolsState(first.handle).set('tab', 'network');
    vi.advanceTimersByTime(200);
    const second = createToolsState({ getState: () => first.saved(), setState: vi.fn() });
    expect(second.get('tab', 'general')).toBe('network');
  });

  it('survives a state of the wrong shape, from another page or an older version', () => {
    for (const raw of [
      undefined,
      null,
      5,
      'x',
      [],
      { other: 1 },
      { datanestTools: 'x' },
      { datanestTools: null },
    ]) {
      expect(createToolsState(api(raw).handle).get('tab', 'general'), JSON.stringify(raw)).toBe(
        'general',
      );
    }
  });

  it('drops stored values that are not plain text, numbers or flags, or are too long', () => {
    const state = createToolsState(
      api({
        datanestTools: { obj: { a: 1 }, list: [1], nul: null, long: 'x'.repeat(2001), ok: 'fine' },
      }).handle,
    );
    expect(state.get('obj', 'd')).toBe('d');
    expect(state.get('list', 'd')).toBe('d');
    expect(state.get('nul', 'd')).toBe('d');
    expect(state.get('long', 'd')).toBe('d');
    expect(state.get('ok', 'd')).toBe('fine');
  });

  it('does not keep a text that is too long, or more than a few hundred keys', () => {
    vi.useFakeTimers();
    const { handle, setState } = api();
    const state = createToolsState(handle);
    state.set('big', 'x'.repeat(2001));
    for (let i = 0; i < 300; i += 1) {
      state.set(`k${i}`, i);
    }
    vi.advanceTimersByTime(200);
    const saved = (setState.mock.calls[0]?.[0] as { datanestTools: Record<string, unknown> })
      .datanestTools;
    expect(saved).not.toHaveProperty('big');
    expect(Object.keys(saved)).toHaveLength(200);
  });

  it('carries on when the editor refuses to read or write the state', () => {
    vi.useFakeTimers();
    const state = createToolsState({
      getState: () => {
        throw new Error('no state');
      },
      setState: () => {
        throw new Error('no state');
      },
    });
    state.set('a', 'b');
    expect(() => vi.advanceTimersByTime(200)).not.toThrow();
    expect(state.get('a', '')).toBe('b');
  });
});
