// Query variables (V10.2.1): asking for the values of `:name` and `${name}` before a run,
// and the values last given, so running a statement again offers them. Those are kept
// in the workspace state: they belong to the project's queries.

import type { SqlStatement } from '../core/sql/split';
import {
  findVariables,
  substituteVariables,
  type Substitution,
  variableNames,
  variableValue,
} from '../core/sql/variables';
import type { Dialect } from '../drivers/driver';
import type { DriverId } from '../shared/connection';
import type { KeyValueState } from './connection-store';

const STATE_KEY = 'datanest.queryVariables';

/** Names kept; the ones used longest ago are forgotten first. */
export const MAX_REMEMBERED_VARIABLES = 200;

/** Longer values are used but not kept: a pasted document is not a variable. */
export const MAX_REMEMBERED_VALUE_LENGTH = 4000;

/** What a query variable does: ask with the last value filled in, just ask, or nothing. */
export type QueryVariablesMode = 'remember' | 'ask' | 'off';

export function isQueryVariablesMode(value: unknown): value is QueryVariablesMode {
  return value === 'remember' || value === 'ask' || value === 'off';
}

type Stored = readonly (readonly [string, string])[];

function isStored(value: unknown): value is Stored {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'string',
    )
  );
}

export class QueryVariableMemory {
  constructor(private readonly state: KeyValueState) {}

  /** The value last given to a name, if it was kept. */
  last(name: string): string | undefined {
    return this.read().get(name);
  }

  /** Keeps the values just given, newest last; too long ones are left out. */
  async remember(values: ReadonlyMap<string, string>): Promise<void> {
    const kept = this.read();
    for (const [name, value] of values) {
      kept.delete(name);
      if (value.length <= MAX_REMEMBERED_VALUE_LENGTH) {
        kept.set(name, value);
      }
    }
    const entries = [...kept].slice(-MAX_REMEMBERED_VARIABLES);
    await this.state.update(STATE_KEY, entries);
  }

  /** Forgets every value, e.g. when the user stops remembering them. */
  async clear(): Promise<void> {
    await this.state.update(STATE_KEY, undefined);
  }

  private read(): Map<string, string> {
    const stored = this.state.get(STATE_KEY);
    return new Map(isStored(stored) ? stored : []);
  }
}

/** Statements with their values in, and how to find their places in the document again. */
export interface FilledStatements {
  readonly statements: readonly SqlStatement[];
  /** By statement start: the substitution of each statement that had variables. */
  readonly substitutions: ReadonlyMap<number, Substitution>;
}

export interface FillVariablesOptions {
  readonly mode: QueryVariablesMode;
  readonly memory: QueryVariableMemory;
  readonly driver: DriverId | undefined;
  /** The dialect is only needed, and its driver only loaded, when there are variables. */
  readonly dialect: () => Promise<Pick<Dialect, 'literal'>>;
  /** Asks for one value, the last one offered; undefined when the user cancelled. */
  readonly ask: (
    name: string,
    index: number,
    count: number,
    last: string | undefined,
  ) => PromiseLike<string | undefined>;
}

/**
 * Asks for each variable of the statements once, in the order they appear, and puts
 * the values in as literals of the dialect. Undefined when the user cancelled.
 */
export async function fillVariables(
  statements: readonly SqlStatement[],
  options: FillVariablesOptions,
): Promise<FilledStatements | undefined> {
  const found = statements.map((statement) =>
    options.mode === 'off' ? [] : findVariables(statement.text, options.driver),
  );
  const names = variableNames(found.flat());
  if (names.length === 0) {
    return { statements, substitutions: new Map() };
  }
  const remember = options.mode === 'remember';
  const given = new Map<string, string>();
  for (const [index, name] of names.entries()) {
    const value = await options.ask(
      name,
      index,
      names.length,
      remember ? options.memory.last(name) : undefined,
    );
    if (value === undefined) {
      return undefined;
    }
    given.set(name, value);
  }
  if (remember) {
    await options.memory.remember(given);
  }
  const dialect = await options.dialect();
  const literals = new Map(
    [...given].map(([name, value]) => [name, dialect.literal(variableValue(value))]),
  );
  const substitutions = new Map<number, Substitution>();
  const filled = statements.map((statement, index) => {
    const variables = found[index] ?? [];
    if (variables.length === 0) {
      return statement;
    }
    // Every name was asked for above, so the fallback is never used.
    const substitution = substituteVariables(
      statement.text,
      variables,
      (name) => literals.get(name) ?? 'NULL',
    );
    substitutions.set(statement.start, substitution);
    return { ...statement, text: substitution.text };
  });
  return { statements: filled, substitutions };
}

/** What the error markers of a run need from each result. */
interface MarkedResult {
  readonly statement: string;
  readonly statementStart: number;
  readonly error?: { readonly position?: number };
}

/**
 * Results as if they had run the document's own text: the statement as written, and
 * an error position moved back from the value to the variable, so markers land right.
 */
export function inDocument<T extends MarkedResult>(
  results: readonly T[],
  original: readonly SqlStatement[],
  substitutions: ReadonlyMap<number, Substitution>,
): T[] {
  const written = new Map(original.map((statement) => [statement.start, statement.text]));
  return results.map((result) => {
    const substitution = substitutions.get(result.statementStart);
    const text = written.get(result.statementStart);
    if (substitution === undefined || text === undefined) {
      return result;
    }
    const position = result.error?.position;
    return {
      ...result,
      statement: text,
      ...(result.error === undefined || position === undefined
        ? {}
        : { error: { ...result.error, position: substitution.toSource(position) } }),
    };
  });
}
