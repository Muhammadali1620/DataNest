// A session that answers each statement from a script: sets of rows by column name, or
// an error. For services that read what servers say about themselves (V8.5).

import type { ExecuteEvent, Session } from '../../src/drivers/driver';
import type { CellValue } from '../../src/shared/cell-value';
import { FakeMetadata } from './fake-driver';

export interface ScriptedSet {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
}

export type ScriptedReply = readonly ScriptedSet[] | Error;

/** One set from records: columns in the order of the first record's keys. */
export function records(rows: readonly Readonly<Record<string, CellValue>>[]): ScriptedSet[] {
  const columns = Object.keys(rows[0] ?? {});
  return [{ columns, rows: rows.map((row) => columns.map((name) => row[name] ?? null)) }];
}

export function scriptedSession(answer: (sql: string) => ScriptedReply | Promise<ScriptedReply>): {
  session: Session;
  executed: string[];
} {
  const executed: string[] = [];
  const session: Session = {
    metadata: new FakeMetadata(),
    execute(sql: string): AsyncIterable<ExecuteEvent> {
      executed.push(sql);
      return (async function* () {
        const reply = await answer(sql);
        if (reply instanceof Error) {
          throw reply;
        }
        for (const set of reply) {
          yield { kind: 'columns', columns: set.columns.map((name) => ({ name })) };
          yield { kind: 'rows', rows: set.rows };
        }
        yield { kind: 'done' };
      })();
    },
    cancel: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return { session, executed };
}
