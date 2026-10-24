import { describe, expect, it, vi } from 'vitest';
import { DisposableStore, toDisposable } from '../../../src/core/disposable';

describe('toDisposable', () => {
  it('runs the cleanup on dispose', () => {
    const cleanup = vi.fn();
    toDisposable(cleanup).dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('runs the cleanup only once', () => {
    const cleanup = vi.fn();
    const disposable = toDisposable(cleanup);
    disposable.dispose();
    disposable.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('does not retry a cleanup that threw', () => {
    const cleanup = vi.fn(() => {
      throw new Error('fail');
    });
    const disposable = toDisposable(cleanup);
    expect(() => {
      disposable.dispose();
    }).toThrow('fail');
    disposable.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe('DisposableStore', () => {
  it('starts empty and not disposed', () => {
    const store = new DisposableStore();
    expect(store.size).toBe(0);
    expect(store.isDisposed).toBe(false);
  });

  it('returns the added item', () => {
    const store = new DisposableStore();
    const item = { dispose: vi.fn(), extra: 1 };
    expect(store.add(item)).toBe(item);
    expect(store.size).toBe(1);
  });

  it('disposes items in reverse order of adding', () => {
    const order: number[] = [];
    const store = new DisposableStore();
    for (const n of [1, 2, 3]) {
      store.add(toDisposable(() => order.push(n)));
    }
    store.dispose();
    expect(order).toEqual([3, 2, 1]);
    expect(store.isDisposed).toBe(true);
    expect(store.size).toBe(0);
  });

  it('disposes only once', () => {
    const item = { dispose: vi.fn() };
    const store = new DisposableStore();
    store.add(item);
    store.dispose();
    store.dispose();
    expect(item.dispose).toHaveBeenCalledOnce();
  });

  it('disposes items added after dispose right away', () => {
    const store = new DisposableStore();
    store.dispose();
    const late = { dispose: vi.fn() };
    store.add(late);
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(store.size).toBe(0);
  });

  it('disposes every item even if one throws, then rethrows that error', () => {
    const first = { dispose: vi.fn() };
    const failure = new Error('cannot close');
    const store = new DisposableStore();
    store.add(first);
    store.add({
      dispose: () => {
        throw failure;
      },
    });
    const last = store.add({ dispose: vi.fn() });
    expect(() => {
      store.dispose();
    }).toThrow(failure);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(last.dispose).toHaveBeenCalledOnce();
    expect(store.isDisposed).toBe(true);
  });

  it('collects several failures into an AggregateError', () => {
    const store = new DisposableStore();
    const errors = [new Error('a'), new Error('b')];
    for (const error of errors) {
      store.add({
        dispose: () => {
          throw error;
        },
      });
    }
    let thrown: unknown;
    try {
      store.dispose();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([errors[1], errors[0]]);
    expect((thrown as AggregateError).message).toBe('2 disposables failed');
  });

  it('can be nested', () => {
    const inner = new DisposableStore();
    const item = inner.add({ dispose: vi.fn() });
    const outer = new DisposableStore();
    outer.add(inner);
    outer.dispose();
    expect(item.dispose).toHaveBeenCalledOnce();
    expect(inner.isDisposed).toBe(true);
  });
});
