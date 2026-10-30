// A session over rows held in memory, for code that reads whole tables: every SELECT
// returns the rows of its table, a batch at a time, and records what was asked.

import { DbError } from '../../src/core/errors';
import type { ExecuteEvent, Session } from '../../src/drivers/driver';
import type { CellValue } from '../../src/shared/cell-value';
import { FakeMetadata } from './fake-driver';

export function tableSession(
  rows: CellValue[][],
  options: { batch?: number; gate?: Promise<void> } = {},
) {
  const executed: string[] = [];
  let cancelled = 0;
  let stopped = false;
  const session: Session = {
    metadata: new FakeMetadata(),
    execute(sql: string): AsyncIterable<ExecuteEvent> {
      executed.push(sql);
      const batch = options.batch ?? 2;
      return (async function* () {
        await Promise.resolve();
        yield { kind: 'columns', columns: [] };
        await options.gate;
        for (let start = 0; start < rows.length; start += batch) {
          if (stopped) {
            throw new DbError('cancelled', 'Query was interrupted');
          }
          yield { kind: 'rows', rows: rows.slice(start, start + batch) };
        }
        yield { kind: 'done' };
      })();
    },
    cancel: () => {
      cancelled += 1;
      stopped = true;
      return Promise.resolve();
    },
    close: () => Promise.resolve(),
  };
  return {
    session,
    executed,
    get cancelled(): number {
      return cancelled;
    },
  };
}
