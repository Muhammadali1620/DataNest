import { describe, expect, it, vi } from 'vitest';
import type { SqlStatement } from '../../../src/core/sql/split';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import {
  fillVariables,
  type FillVariablesOptions,
  inDocument,
  isQueryVariablesMode,
  MAX_REMEMBERED_VALUE_LENGTH,
  MAX_REMEMBERED_VARIABLES,
  QueryVariableMemory,
} from '../../../src/services/query-variables';
import { FakeMemento } from '../../helpers/fakes';

function statement(text: string, start = 0): SqlStatement {
  return { text, start, end: start + text.length };
}

/** Options that answer each question from `answers`, recording what was asked. */
function options(
  answers: Record<string, string | undefined>,
  overrides: Partial<FillVariablesOptions> = {},
): FillVariablesOptions & { asked: unknown[][]; dialectLoads: () => number } {
  const asked: unknown[][] = [];
  let loads = 0;
  return {
    mode: 'remember',
    memory: new QueryVariableMemory(new FakeMemento()),
    driver: 'postgres',
    dialect: () => {
      loads++;
      return Promise.resolve(postgresDialect);
    },
    ask: (name, index, count, last) => {
      asked.push([name, index, count, last]);
      return Promise.resolve(answers[name]);
    },
    ...overrides,
    asked,
    dialectLoads: () => loads,
  };
}

describe('isQueryVariablesMode', () => {
  it('knows the three modes and nothing else', () => {
    expect(['remember', 'ask', 'off'].every(isQueryVariablesMode)).toBe(true);
    for (const value of ['Remember', '', undefined, null, 1, true]) {
      expect(isQueryVariablesMode(value)).toBe(false);
    }
  });
});

describe('QueryVariableMemory', () => {
  it('knows nothing at first', () => {
    expect(new QueryVariableMemory(new FakeMemento()).last('id')).toBeUndefined();
  });

  it('gives back the value given last', async () => {
    const memory = new QueryVariableMemory(new FakeMemento());
    await memory.remember(new Map([['id', '1']]));
    await memory.remember(new Map([['id', '2']]));
    expect(memory.last('id')).toBe('2');
  });

  it('keeps values across instances on the same state', async () => {
    const state = new FakeMemento();
    await new QueryVariableMemory(state).remember(new Map([['code', "'007'"]]));
    expect(new QueryVariableMemory(state).last('code')).toBe("'007'");
  });

  it('keeps empty values: an empty answer is an answer', async () => {
    const memory = new QueryVariableMemory(new FakeMemento());
    await memory.remember(new Map([['note', '']]));
    expect(memory.last('note')).toBe('');
  });

  it('does not keep a value that is too long, and forgets the older one', async () => {
    const memory = new QueryVariableMemory(new FakeMemento());
    await memory.remember(new Map([['doc', 'short']]));
    await memory.remember(new Map([['doc', 'x'.repeat(MAX_REMEMBERED_VALUE_LENGTH + 1)]]));
    expect(memory.last('doc')).toBeUndefined();
    await memory.remember(new Map([['doc', 'y'.repeat(MAX_REMEMBERED_VALUE_LENGTH)]]));
    expect(memory.last('doc')).toHaveLength(MAX_REMEMBERED_VALUE_LENGTH);
  });

  it('forgets the names used longest ago past the limit', async () => {
    const memory = new QueryVariableMemory(new FakeMemento());
    const many = new Map(
      Array.from({ length: MAX_REMEMBERED_VARIABLES + 5 }, (_, index) => [`v${index}`, `${index}`]),
    );
    await memory.remember(many);
    expect(memory.last('v0')).toBeUndefined();
    expect(memory.last('v4')).toBeUndefined();
    expect(memory.last('v5')).toBe('5');
    // Using an old name again makes it the newest.
    await memory.remember(new Map([['v5', 'again']]));
    await memory.remember(new Map([['fresh', '1']]));
    expect(memory.last('v5')).toBe('again');
    expect(memory.last('v6')).toBeUndefined();
  });

  it('ignores a state it does not recognise', () => {
    for (const stored of [{ id: '1' }, [['id']], [['id', 1]], 'id', [null]]) {
      const memory = new QueryVariableMemory(
        new FakeMemento(new Map([['datanest.queryVariables', stored]])),
      );
      expect(memory.last('id')).toBeUndefined();
    }
  });

  it('forgets everything when cleared', async () => {
    const state = new FakeMemento();
    const memory = new QueryVariableMemory(state);
    await memory.remember(new Map([['id', '1']]));
    await memory.clear();
    expect(memory.last('id')).toBeUndefined();
    expect(state.data.size).toBe(0);
  });
});

describe('fillVariables', () => {
  it('runs statements without variables as they are, without asking or loading a driver', async () => {
    const written = [statement('SELECT 1'), statement("SELECT ':x'", 10)];
    const opts = options({});
    const filled = await fillVariables(written, opts);
    expect(filled?.statements).toBe(written);
    expect(filled?.substitutions.size).toBe(0);
    expect(opts.asked).toEqual([]);
    expect(opts.dialectLoads()).toBe(0);
  });

  it('asks for each name once, in order, and puts the values in as literals', async () => {
    const written = [
      statement('SELECT * FROM t WHERE id = :id AND name = ${name}'),
      statement('UPDATE t SET seen = TRUE WHERE id = :id', 60),
    ];
    const opts = options({ id: '42', name: "O'Brien" });
    const filled = await fillVariables(written, opts);
    expect(opts.asked).toEqual([
      ['id', 0, 2, undefined],
      ['name', 1, 2, undefined],
    ]);
    expect(filled?.statements.map((one) => one.text)).toEqual([
      "SELECT * FROM t WHERE id = 42 AND name = 'O''Brien'",
      'UPDATE t SET seen = TRUE WHERE id = 42',
    ]);
    // Offsets stay those of the document, so the run and its results still line up.
    expect(filled?.statements.map((one) => [one.start, one.end])).toEqual(
      written.map((one) => [one.start, one.end]),
    );
    expect([...(filled?.substitutions.keys() ?? [])]).toEqual([0, 60]);
  });

  it('only substitutes the statements that have variables', async () => {
    const plain = statement('SELECT 1');
    const filled = await fillVariables([plain, statement('SELECT :x', 9)], options({ x: 'NULL' }));
    expect(filled?.statements[0]).toBe(plain);
    expect(filled?.statements[1]?.text).toBe('SELECT NULL');
    expect(filled?.substitutions.has(0)).toBe(false);
  });

  it('offers the value given last time and remembers the new one', async () => {
    const memory = new QueryVariableMemory(new FakeMemento());
    await memory.remember(new Map([['id', '7']]));
    const opts = options({ id: '8' }, { memory });
    await fillVariables([statement('SELECT :id')], opts);
    expect(opts.asked).toEqual([['id', 0, 1, '7']]);
    expect(memory.last('id')).toBe('8');
  });

  it('just asks in the ask mode: nothing offered, nothing kept', async () => {
    const memory = new QueryVariableMemory(new FakeMemento());
    await memory.remember(new Map([['id', '7']]));
    const opts = options({ id: '8' }, { memory, mode: 'ask' });
    const filled = await fillVariables([statement('SELECT :id')], opts);
    expect(opts.asked).toEqual([['id', 0, 1, undefined]]);
    expect(memory.last('id')).toBe('7');
    expect(filled?.statements[0]?.text).toBe('SELECT 8');
  });

  it('leaves the text alone when variables are off', async () => {
    const written = [statement('SELECT :id, ${x}')];
    const opts = options({ id: '1' }, { mode: 'off' });
    const filled = await fillVariables(written, opts);
    expect(filled?.statements).toBe(written);
    expect(opts.asked).toEqual([]);
  });

  it('stops at the first cancelled question and keeps nothing', async () => {
    const memory = new QueryVariableMemory(new FakeMemento());
    const ask = vi.fn((name: string) => Promise.resolve(name === 'a' ? '1' : undefined));
    const filled = await fillVariables(
      [statement('SELECT :a, :b, :c')],
      options({}, { memory, ask }),
    );
    expect(filled).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(2);
    expect(memory.last('a')).toBeUndefined();
  });

  it('does not touch the binds of a trigger definition', async () => {
    const written = [statement('CREATE TRIGGER t BEFORE INSERT ON x BEGIN :new.id := 1; END')];
    const opts = options({});
    const filled = await fillVariables(written, opts);
    expect(filled?.statements).toBe(written);
    expect(opts.asked).toEqual([]);
  });

  it('reads the syntax of the connection’s driver', async () => {
    // In MySQL `#` starts a comment; elsewhere it does not, and `:x` after it is real.
    const sql = 'SELECT 1 # :x';
    const mysql = options({ x: '1' }, { driver: 'mysql' });
    await fillVariables([statement(sql)], mysql);
    expect(mysql.asked).toEqual([]);
    const postgres = options({ x: '1' }, { driver: 'postgres' });
    await fillVariables([statement(sql)], postgres);
    expect(postgres.asked).toHaveLength(1);
  });
});

describe('inDocument', () => {
  it('gives results back the written statement and moves error positions to it', async () => {
    const written = [statement('SELECT :id FROM nowhere', 5)];
    const filled = await fillVariables(written, options({ id: "'a long value'" }));
    expect(filled).toBeDefined();
    const ran = filled?.statements[0]?.text ?? '';
    const results = [
      {
        statement: ran,
        statementStart: 5,
        error: { code: 'not-found', message: 'no table', position: ran.indexOf('nowhere') },
      },
    ];
    const [mapped] = inDocument(results, written, filled?.substitutions ?? new Map());
    expect(mapped?.statement).toBe('SELECT :id FROM nowhere');
    expect(mapped?.error).toEqual({
      code: 'not-found',
      message: 'no table',
      position: 'SELECT :id FROM '.length,
    });
  });

  it('points an error inside a value at its variable', async () => {
    const written = [statement('SELECT :v')];
    const filled = await fillVariables(written, options({ v: 'abc' }));
    const [mapped] = inDocument(
      [{ statement: "SELECT 'abc'", statementStart: 0, error: { position: 9 } }],
      written,
      filled?.substitutions ?? new Map(),
    );
    expect(mapped?.error.position).toBe(7);
  });

  it('keeps results without substitutions, errors or positions as they are', async () => {
    const written = [statement('SELECT 1'), statement('SELECT :v', 9)];
    const filled = await fillVariables(written, options({ v: '2' }));
    const substitutions = filled?.substitutions ?? new Map();
    const plain = { statement: 'SELECT 1', statementStart: 0, error: { position: 3 } };
    const fine = { statement: 'SELECT 2', statementStart: 9 };
    const lost = { statement: 'SELECT 2', statementStart: 9, error: { code: 'connection-failed' } };
    const [first, second, third] = inDocument([plain, fine, lost], written, substitutions);
    expect(first).toBe(plain);
    expect(second).toEqual({ statement: 'SELECT :v', statementStart: 9 });
    expect(third).toEqual({
      statement: 'SELECT :v',
      statementStart: 9,
      error: { code: 'connection-failed' },
    });
  });

  it('keeps a result whose statement it cannot find', () => {
    const odd = { statement: 'SELECT 9', statementStart: 99 };
    const substitutions = new Map([[99, { text: 'SELECT 9', toSource: (p: number) => p }]]);
    expect(inDocument([odd], [], substitutions)).toEqual([odd]);
  });
});
