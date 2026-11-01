import { describe, expect, it, vi } from 'vitest';
import {
  MAX_REMEMBERED_FILES,
  MAX_REMEMBERED_STATEMENT,
  MAX_REMEMBERED_TABS,
  recordResults,
  type RememberRules,
  type RememberedTab,
  ResultMemory,
  ResultRestorer,
  type RestorableConnection,
  tabOf,
} from '../../../src/services/result-memory';
import { ResultStore, type NewResult } from '../../../src/services/result-store';
import { FakeMemento } from '../../helpers/fakes';

const FILE = 'file:///work/report.sql';
const OTHER = 'file:///work/other.sql';
const TARGET = { connectionId: 'c1', database: 'shop' };
const READS: RememberRules = {
  isReadOnly: (statement) => statement.trimStart().toUpperCase().startsWith('SELECT'),
};

function tab(statement = 'SELECT 1', overrides: Partial<RememberedTab> = {}): RememberedTab {
  return { statement, statementStart: 0, pinned: false, target: TARGET, ...overrides };
}

function ran(overrides: Partial<NewResult> = {}): NewResult {
  return {
    documentUri: FILE,
    statement: 'SELECT 1',
    statementStart: 0,
    columns: [{ name: 'one' }],
    rows: [[1]],
    truncated: false,
    durationMs: 3,
    origin: { target: TARGET, owner: 'editor:1' },
    ...overrides,
  };
}

describe('ResultMemory', () => {
  it('keeps the tabs of a file and gives them back, also to a new instance', async () => {
    const state = new FakeMemento();
    await new ResultMemory(state).remember(FILE, [
      tab('SELECT 1'),
      tab('SELECT 2', { pinned: true }),
    ]);
    const again = new ResultMemory(state);
    expect(again.get(FILE).map((one) => [one.statement, one.pinned])).toEqual([
      ['SELECT 1', false],
      ['SELECT 2', true],
    ]);
    expect(again.get(OTHER)).toEqual([]);
  });

  it('keeps no rows, no secrets: only the statement, its place and its connection', async () => {
    const state = new FakeMemento();
    await new ResultMemory(state).remember(FILE, [
      { ...tab(), password: 'hunter2', rows: [[1]] } as RememberedTab,
    ]);
    const text = JSON.stringify([...state.data.values()]);
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('rows');
  });

  it('skips untitled documents: they do not outlive the editor', async () => {
    const state = new FakeMemento();
    await new ResultMemory(state).remember('untitled:Untitled-1', [tab()]);
    expect(state.data.size).toBe(0);
  });

  it('does not write again when nothing changed', async () => {
    const state = new FakeMemento();
    const memory = new ResultMemory(state);
    await memory.remember(FILE, [tab()]);
    const update = vi.spyOn(state, 'update');
    await memory.remember(FILE, [tab()]);
    expect(update).not.toHaveBeenCalled();
  });

  it('forgets a file left with nothing to keep, and only that file', async () => {
    const memory = new ResultMemory(new FakeMemento());
    await memory.remember(FILE, [tab()]);
    await memory.remember(OTHER, [tab('SELECT 9')]);
    await memory.remember(FILE, []);
    expect(memory.get(FILE)).toEqual([]);
    expect(memory.get(OTHER)).toHaveLength(1);
  });

  it('forgetting a file that is not kept writes nothing', async () => {
    const state = new FakeMemento();
    const update = vi.spyOn(state, 'update');
    await new ResultMemory(state).remember(FILE, []);
    expect(update).not.toHaveBeenCalled();
  });

  it('caps the tabs of a file, keeping the newest', async () => {
    const memory = new ResultMemory(new FakeMemento());
    const many = Array.from({ length: MAX_REMEMBERED_TABS + 5 }, (_, index) =>
      tab(`SELECT ${index}`),
    );
    await memory.remember(FILE, many);
    const kept = memory.get(FILE);
    expect(kept).toHaveLength(MAX_REMEMBERED_TABS);
    expect(kept.at(-1)?.statement).toBe(`SELECT ${MAX_REMEMBERED_TABS + 4}`);
  });

  it('caps the files, forgetting the ones touched longest ago', async () => {
    const memory = new ResultMemory(new FakeMemento());
    for (let index = 0; index < MAX_REMEMBERED_FILES + 2; index += 1) {
      await memory.remember(`file:///f${index}.sql`, [tab(`SELECT ${index}`)]);
    }
    expect(memory.get('file:///f0.sql')).toEqual([]);
    expect(memory.get('file:///f1.sql')).toEqual([]);
    expect(memory.get('file:///f2.sql')).toHaveLength(1);
    expect(memory.get(`file:///f${MAX_REMEMBERED_FILES + 1}.sql`)).toHaveLength(1);
  });

  it('touching a file keeps it longer than the others', async () => {
    const memory = new ResultMemory(new FakeMemento());
    await memory.remember('file:///first.sql', [tab('SELECT 1')]);
    for (let index = 0; index < MAX_REMEMBERED_FILES - 1; index += 1) {
      await memory.remember(`file:///f${index}.sql`, [tab()]);
    }
    await memory.remember('file:///first.sql', [tab('SELECT 2')]);
    await memory.remember('file:///newest.sql', [tab()]);
    expect(memory.get('file:///first.sql')).toHaveLength(1);
    expect(memory.get('file:///f0.sql')).toEqual([]);
  });

  it('does not keep a statement that is too long, empty or without a connection', async () => {
    const memory = new ResultMemory(new FakeMemento());
    await memory.remember(FILE, [
      tab('x'.repeat(MAX_REMEMBERED_STATEMENT + 1)),
      tab('   '),
      { ...tab(), target: { connectionId: '' } },
      tab('SELECT 1'),
    ]);
    expect(memory.get(FILE).map((one) => one.statement)).toEqual(['SELECT 1']);
  });

  it('moves the tabs with a renamed file, and drops them for a name that is not kept', async () => {
    const memory = new ResultMemory(new FakeMemento());
    await memory.remember(FILE, [tab()]);
    await memory.rename(FILE, 'file:///work/renamed.sql');
    expect(memory.get(FILE)).toEqual([]);
    expect(memory.get('file:///work/renamed.sql')).toHaveLength(1);
    await memory.rename('file:///work/renamed.sql', 'untitled:Untitled-2');
    expect(memory.get('file:///work/renamed.sql')).toEqual([]);
    await memory.rename('file:///nothing.sql', OTHER);
    expect(memory.get(OTHER)).toEqual([]);
  });

  it('reads damaged state as empty instead of trusting it', () => {
    for (const junk of [
      'text',
      42,
      { a: 1 },
      [['file:///x.sql']],
      [['file:///x.sql', 'nope']],
      [['file:///x.sql', [{ statement: 5 }]]],
      [
        [
          'file:///x.sql',
          [{ statement: 'SELECT 1', statementStart: 'a', pinned: false, target: TARGET }],
        ],
      ],
      [['untitled:1', [tab()]]],
      [[7, [tab()]]],
      [['file:///x.sql', [{ ...tab(), target: 'c1' }]]],
    ]) {
      const state = new FakeMemento();
      state.data.set('datanest.rememberedResults', junk);
      expect(new ResultMemory(state).get('file:///x.sql')).toEqual([]);
    }
  });

  it('keeps the good entries next to a damaged one', () => {
    const state = new FakeMemento();
    state.data.set('datanest.rememberedResults', [
      ['file:///bad.sql', 'nope'],
      [FILE, [tab('SELECT 1'), { statement: 3 }]],
    ]);
    expect(new ResultMemory(state).get(FILE)).toHaveLength(1);
  });

  it('cleans a negative or fractional start', () => {
    const state = new FakeMemento();
    state.data.set('datanest.rememberedResults', [
      [FILE, [tab('SELECT 1', { statementStart: -4.5 })]],
    ]);
    expect(new ResultMemory(state).get(FILE)[0]?.statementStart).toBe(0);
  });
});

describe('tabOf', () => {
  const store = new ResultStore();
  const summary = (overrides: Partial<NewResult> = {}) => store.add(ran(overrides));

  it('turns a result into a tab with its connection', () => {
    expect(tabOf(summary({ statementStart: 12 }), READS)).toEqual({
      statement: 'SELECT 1',
      statementStart: 12,
      pinned: false,
      target: TARGET,
    });
  });

  it('keeps a connection without a database as it is', () => {
    const tabValue = tabOf(
      summary({ origin: { target: { connectionId: 'c2' }, owner: 'o' } }),
      READS,
    );
    expect(tabValue?.target).toEqual({ connectionId: 'c2' });
  });

  it('refuses what cannot be run again safely or at all', () => {
    expect(tabOf(summary({ statement: 'DELETE FROM t' }), READS)).toBeUndefined();
    expect(tabOf(summary({ error: { code: 'x', message: 'm' } }), READS)).toBeUndefined();
    expect(tabOf(summary({ page: { offset: 0, pageSize: 10 } }), READS)).toBeUndefined();
    expect(tabOf(summary({ statement: '  ' }), READS)).toBeUndefined();
    expect(
      tabOf(summary({ statement: `SELECT '${'x'.repeat(MAX_REMEMBERED_STATEMENT)}'` }), READS),
    ).toBeUndefined();
    const { origin: _origin, ...bare } = ran();
    expect(tabOf(store.add(bare), READS)).toBeUndefined();
  });

  it('carries the pin', () => {
    const added = summary();
    store.pin(added.id);
    const pinned = store.get(added.id);
    expect(pinned && tabOf(pinned, READS)?.pinned).toBe(true);
  });
});

describe('recordResults', () => {
  function setup() {
    const state = new FakeMemento();
    const memory = new ResultMemory(state);
    const results = new ResultStore();
    const errors: unknown[] = [];
    const subscription = recordResults(results, memory, READS, (error) => errors.push(error));
    return { state, memory, results, errors, subscription };
  }

  it('remembers the tabs as they are run', async () => {
    const { memory, results } = setup();
    results.add(ran());
    results.add(ran({ statement: 'SELECT 2' }));
    await Promise.resolve();
    await Promise.resolve();
    expect(memory.get(FILE).map((one) => one.statement)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('follows a re-run: the replaced tab goes, the new one comes', async () => {
    const { memory, results } = setup();
    const first = results.add(ran());
    results.add(ran({ statement: 'SELECT 5' }), { replace: first.id });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memory.get(FILE).map((one) => one.statement)).toEqual(['SELECT 5']);
  });

  it('forgets a file whose results are all of statements that change data', async () => {
    const { memory, results } = setup();
    const first = results.add(ran());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memory.get(FILE)).toHaveLength(1);
    results.add(ran({ statement: 'UPDATE t SET a = 1' }), { replace: first.id });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memory.get(FILE)).toEqual([]);
  });

  it('leaves the memory alone when the results are cleared, as at shutdown', async () => {
    const { memory, results } = setup();
    results.add(ran());
    await new Promise((resolve) => setTimeout(resolve, 0));
    results.clearDocument(FILE);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memory.get(FILE)).toHaveLength(1);
  });

  it('ignores documents that are not kept', async () => {
    const { state, results } = setup();
    results.add(ran({ documentUri: 'untitled:Untitled-1' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.data.size).toBe(0);
  });

  it('reports a failed write instead of throwing', async () => {
    const state = new FakeMemento();
    vi.spyOn(state, 'update').mockRejectedValue(new Error('disk full'));
    const results = new ResultStore();
    const errors: unknown[] = [];
    recordResults(results, new ResultMemory(state), READS, (error) => errors.push(error));
    results.add(ran());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(errors).toHaveLength(1);
  });

  it('stops when the subscription is disposed', async () => {
    const { memory, results, subscription } = setup();
    subscription.dispose();
    results.add(ran());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(memory.get(FILE)).toEqual([]);
  });
});

describe('ResultRestorer', () => {
  const connections = new Map<string, RestorableConnection>([
    ['c1', { disabled: false, production: false }],
    ['off', { disabled: true, production: false }],
    ['prod', { disabled: false, production: true }],
  ]);

  async function setup(tabs: RememberedTab[], options: { autoRun?: boolean; run?: boolean } = {}) {
    const memory = new ResultMemory(new FakeMemento());
    await memory.remember(FILE, tabs);
    const results = new ResultStore();
    const run = vi.fn(
      (request: { replace: { resultId: string }; sql: string; documentUri: string }) => {
        results.add(ran({ statement: request.sql }), { replace: request.replace.resultId });
        return Promise.resolve({ ok: true });
      },
    );
    const errors: unknown[] = [];
    const restorer = new ResultRestorer({
      memory,
      results,
      connectionOf: (id) => connections.get(id),
      rules: READS,
      ...(options.run === false ? {} : { run }),
      autoRun: () => options.autoRun === true,
      onError: (error) => errors.push(error),
    });
    return { restorer, results, run, memory, errors };
  }

  it('puts the tabs back empty, in order, marked as restored', async () => {
    const { restorer, results, run } = await setup([
      tab('SELECT 1'),
      tab('SELECT 2', { pinned: true }),
    ]);
    const outcome = restorer.restore(FILE);
    await outcome.finished;
    expect(outcome.restored).toBe(2);
    const shown = results.forDocument(FILE);
    expect(shown.map((one) => [one.statement, one.restored, one.pinned, one.rowCount])).toEqual([
      ['SELECT 1', true, false, 0],
      ['SELECT 2', true, true, 0],
    ]);
    expect(shown[0]?.origin?.target).toEqual(TARGET);
    expect(run).not.toHaveBeenCalled();
  });

  it('puts nothing back for a file that remembers nothing, or is not kept', async () => {
    const { restorer, results } = await setup([]);
    expect(restorer.restore(FILE).restored).toBe(0);
    expect(restorer.restore('untitled:Untitled-1').restored).toBe(0);
    expect(results.size).toBe(0);
  });

  it('leaves a file alone that already shows a result of its own', async () => {
    const { restorer, results } = await setup([tab('SELECT 1')]);
    results.add(ran({ statement: 'SELECT 7' }));
    expect(restorer.restore(FILE).restored).toBe(0);
    expect(results.forDocument(FILE)).toHaveLength(1);
  });

  it('is safe to ask again: a tab is never put back twice', async () => {
    const { restorer, results } = await setup([tab('SELECT 1')]);
    expect(restorer.restore(FILE).restored).toBe(1);
    expect(restorer.restore(FILE).restored).toBe(0);
    expect(results.forDocument(FILE)).toHaveLength(1);
  });

  it('skips tabs of a connection that is not known, and adds them once it is', async () => {
    const memory = new ResultMemory(new FakeMemento());
    await memory.remember(FILE, [
      tab('SELECT 1'),
      tab('SELECT 2', { target: { connectionId: 'late' } }),
    ]);
    const results = new ResultStore();
    const known = new Map(connections);
    const restorer = new ResultRestorer({
      memory,
      results,
      connectionOf: (id) => known.get(id),
      rules: READS,
      autoRun: () => false,
    });
    expect(restorer.restore(FILE).restored).toBe(1);
    // The tab of the unknown connection stays in the memory.
    expect(memory.get(FILE)).toHaveLength(2);
    known.set('late', { disabled: false, production: false });
    expect(restorer.restore(FILE).restored).toBe(1);
    expect(results.forDocument(FILE).map((one) => one.statement)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('runs the tabs again only when asked to, replacing each in place', async () => {
    const { restorer, results, run } = await setup([tab('SELECT 1'), tab('SELECT 2')], {
      autoRun: true,
    });
    const outcome = restorer.restore(FILE);
    await outcome.finished;
    expect(run).toHaveBeenCalledTimes(2);
    const shown = results.forDocument(FILE);
    expect(shown.map((one) => [one.statement, one.restored])).toEqual([
      ['SELECT 1', undefined],
      ['SELECT 2', undefined],
    ]);
  });

  it('a pinned tab keeps its pin when it is run', async () => {
    const { restorer, results } = await setup([tab('SELECT 1', { pinned: true })], {
      autoRun: true,
    });
    await restorer.restore(FILE).finished;
    const [only] = results.forDocument(FILE);
    expect(only?.pinned).toBe(true);
    expect(only?.restored).toBeUndefined();
    expect(results.forDocument(FILE)).toHaveLength(1);
  });

  it('never runs on its own for production, a switched-off connection or a statement that changes data', async () => {
    const { restorer, results, run } = await setup(
      [
        tab('SELECT 1', { target: { connectionId: 'prod' } }),
        tab('SELECT 2', { target: { connectionId: 'off' } }),
        tab('DELETE FROM t'),
        tab('SELECT 3'),
      ],
      { autoRun: true },
    );
    const outcome = restorer.restore(FILE);
    await outcome.finished;
    expect(outcome.restored).toBe(4);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].sql).toBe('SELECT 3');
    expect(results.forDocument(FILE).filter((one) => one.restored === true)).toHaveLength(3);
  });

  it('does not run without a runner', async () => {
    const { restorer, results } = await setup([tab('SELECT 1')], { autoRun: true, run: false });
    await restorer.restore(FILE).finished;
    expect(results.forDocument(FILE)[0]?.restored).toBe(true);
  });

  it('goes on with the next tab when one run fails', async () => {
    const memory = new ResultMemory(new FakeMemento());
    await memory.remember(FILE, [tab('SELECT 1'), tab('SELECT 2')]);
    const results = new ResultStore();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('lost link'))
      .mockImplementation((request: { replace: { resultId: string }; sql: string }) => {
        results.add(ran({ statement: request.sql }), { replace: request.replace.resultId });
        return Promise.resolve({ ok: true });
      });
    const errors: unknown[] = [];
    const restorer = new ResultRestorer({
      memory,
      results,
      connectionOf: (id) => connections.get(id),
      rules: READS,
      run,
      autoRun: () => true,
      onError: (error) => errors.push(error),
    });
    await restorer.restore(FILE).finished;
    expect(errors).toHaveLength(1);
    expect(run).toHaveBeenCalledTimes(2);
    expect(results.forDocument(FILE).map((one) => one.restored)).toEqual([true, undefined]);
  });

  it('a run elsewhere in the file leaves a pinned restored tab alone and drops the unpinned one', async () => {
    const { restorer, results } = await setup([tab('SELECT 1', { pinned: true }), tab('SELECT 2')]);
    restorer.restore(FILE);
    results.add(ran({ statement: 'SELECT 9' }), { replaceAll: true });
    expect(results.forDocument(FILE).map((one) => one.statement)).toEqual(['SELECT 1', 'SELECT 9']);
  });
});
