import { describe, expect, it } from 'vitest';
import {
  VERSION_MEMORY_KEY,
  VersionMemory,
  versionTarget,
  type MemoryStorage,
} from '../../../src/services/version-memory';

function storage(
  initial?: unknown,
): MemoryStorage & { writes: number; data: Map<string, unknown> } {
  const data = new Map<string, unknown>(
    initial === undefined ? [] : [[VERSION_MEMORY_KEY, initial]],
  );
  const memo = {
    writes: 0,
    data,
    get(key: string): unknown {
      return data.get(key);
    },
    update(key: string, value: unknown): Promise<void> {
      memo.writes += 1;
      data.set(key, value);
      return Promise.resolve();
    },
  };
  return memo;
}

const PG = { driver: 'postgres', host: 'db.local', port: 5432 } as const;

describe('VersionMemory', () => {
  it('knows nothing before a version is seen', () => {
    expect(new VersionMemory(storage()).recall('a', PG)).toBeUndefined();
  });

  it('recalls what was remembered, also in a new instance over the same storage', async () => {
    const memo = storage();
    await new VersionMemory(memo).remember('a', PG, '15.19');
    expect(new VersionMemory(memo).recall('a', PG)).toBe('15.19');
    expect(new VersionMemory(memo).recall('b', PG)).toBeUndefined();
  });

  it('does not write again for the same version, but does for a new one', async () => {
    const memo = storage();
    const memory = new VersionMemory(memo);
    await memory.remember('a', PG, '15.19');
    await memory.remember('a', PG, '15.19');
    expect(memo.writes).toBe(1);
    await memory.remember('a', PG, '16.2');
    expect(memo.writes).toBe(2);
    expect(memory.recall('a', PG)).toBe('16.2');
  });

  it.each([
    ['host', { ...PG, host: 'other' }],
    ['port', { ...PG, port: 5433 }],
    ['driver', { ...PG, driver: 'mysql' as const }],
    ['socket', { ...PG, socket: '/tmp/pg.sock' }],
  ])('forgets the version once the %s changes', async (_name, changed) => {
    const memory = new VersionMemory(storage());
    await memory.remember('a', PG, '15.19');
    expect(memory.recall('a', changed)).toBeUndefined();
  });

  it('keeps the version of a SQLite file by its path', async () => {
    const memory = new VersionMemory(storage());
    const file = { driver: 'sqlite', file: '/data/a.db' } as const;
    await memory.remember('f', file, '3.46.0');
    expect(memory.recall('f', file)).toBe('3.46.0');
    expect(memory.recall('f', { ...file, file: '/data/b.db' })).toBeUndefined();
  });

  it('prune drops removed connections and moved ones, keeps the rest', async () => {
    const memo = storage();
    const memory = new VersionMemory(memo);
    await memory.remember('keep', PG, '15.19');
    await memory.remember('gone', PG, '14.1');
    await memory.remember('moved', PG, '13.0');
    await memory.prune(
      new Map([
        ['keep', PG],
        ['moved', { ...PG, host: 'new-host' }],
      ]),
    );
    expect(memory.recall('keep', PG)).toBe('15.19');
    expect(memory.recall('gone', PG)).toBeUndefined();
    expect(memo.data.get(VERSION_MEMORY_KEY)).toEqual({
      keep: { version: '15.19', target: versionTarget(PG) },
    });
  });

  it('prune writes nothing when nothing is dropped', async () => {
    const memo = storage();
    const memory = new VersionMemory(memo);
    await memory.remember('a', PG, '15.19');
    const before = memo.writes;
    await memory.prune(new Map([['a', PG]]));
    expect(memo.writes).toBe(before);
  });

  it.each([[null], ['text'], [['a']], [{ a: { version: 5, target: 'x' } }], [{ a: null }]])(
    'ignores damaged stored state %j',
    (stored) => {
      expect(new VersionMemory(storage(stored)).recall('a', PG)).toBeUndefined();
    },
  );

  it('overwrites damaged stored state on the next write', async () => {
    const memo = storage('text');
    const memory = new VersionMemory(memo);
    await memory.remember('a', PG, '15.19');
    expect(memory.recall('a', PG)).toBe('15.19');
  });
});
