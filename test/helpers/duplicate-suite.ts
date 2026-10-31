// The checks of "Duplicate Table…" (V10.2.3) every real server goes through: the
// transfer runs on one session and the server copies the rows itself; the copy gets
// its own index and key names, a key to itself points at the copy, and numbering goes
// on after the copied rows.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectScope } from '../../src/core/model/objects';
import type { Driver, Session } from '../../src/drivers/driver';
import {
  type TransferContent,
  type TransferReport,
  TableTransferService,
} from '../../src/services/transfer/table-transfer';
import type { ResolvedConnectionConfig } from '../../src/shared/connection';
import { firstColumn, runAll } from './driver-run';
import { RecordingLogger } from './fakes';

export interface DuplicatePlace {
  readonly label: string;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  readonly scope: ObjectScope;
  /**
   * Statements that make `staff` (id, name, boss) with three rows — Ann, Bob, Cy — and,
   * where the server has them, numbered ids, an index on name and a key from boss to id.
   */
  readonly create: readonly string[];
  /** Statements that drop a table if it is there. */
  readonly drop: (table: string) => readonly string[];
  /** How SQL in the test names a table here. */
  readonly name: (table: string) => string;
  /** Spelled as the server reports names (Oracle: upper case). */
  readonly reported: (table: string) => string;
  /** The server numbers ids and has foreign keys (not ClickHouse). */
  readonly keys: boolean;
}

async function use<T>(place: DuplicatePlace, run: (session: Session) => Promise<T>): Promise<T> {
  const session = await place.driver().openSession(place.config());
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

/** Duplicates `staff` as `staff_copy`, counting how many sessions the copy opened. */
async function duplicate(
  place: DuplicatePlace,
  content: TransferContent = 'all',
): Promise<{ report: TransferReport; sessions: number }> {
  let sessions = 0;
  const open = new Map<string, Session>();
  const service = new TableTransferService({
    manager: {
      driverOf: () => Promise.resolve(place.driver()),
      acquire: async (owner) => {
        sessions++;
        const session = await place.driver().openSession(place.config());
        open.set(owner, session);
        return session;
      },
      release: async (owner) => {
        await open.get(owner)?.close();
        open.delete(owner);
      },
    },
    logger: new RecordingLogger(),
  });
  const end = {
    target: {
      connectionId: 'here',
      ...(place.scope.database === undefined ? {} : { database: place.scope.database }),
    },
    scope: place.scope,
  };
  const staff = place.reported('staff');
  const report = await service.transfer({
    source: end,
    destination: end,
    tables: [staff],
    renames: new Map([[staff, place.reported('staff_copy')]]),
    content,
    existing: 'skip',
  });
  return { report, sessions };
}

async function count(session: Session, place: DuplicatePlace, table: string): Promise<number> {
  return Number(firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${place.name(table)}`))[0]);
}

export function duplicateSuite(place: DuplicatePlace): void {
  describe(`duplicating a table on ${place.label}`, () => {
    const dropBoth = async (): Promise<void> => {
      await use(place, async (session) => {
        for (const statement of [...place.drop('staff_copy'), ...place.drop('staff')]) {
          await runAll(session, statement);
        }
      });
    };

    beforeAll(async () => {
      await dropBoth();
      await use(place, async (session) => {
        for (const statement of place.create) {
          await runAll(session, statement);
        }
      });
    });

    afterAll(async () => {
      await dropBoth();
    });

    it('copies the structure and every row on one session', async () => {
      const { report, sessions } = await duplicate(place);
      expect(report.tables[0]?.error).toBeUndefined();
      expect(report.tables[0]).toMatchObject({ outcome: 'copied', created: true, rows: 3 });
      expect(sessions).toBe(1);
      await use(place, async (session) => {
        const names = firstColumn(
          await runAll(session, `SELECT name FROM ${place.name('staff_copy')} ORDER BY id`),
        );
        expect(names).toEqual(['Ann', 'Bob', 'Cy']);
        expect(await count(session, place, 'staff')).toBe(3);
      });
    });

    it.runIf(place.keys)('gives the copy its own index and a key to itself', async () => {
      await use(place, async (session) => {
        const copy = { ...place.scope, name: place.reported('staff_copy') };
        const indexes = await session.metadata.listIndexes(copy);
        const own = indexes.filter((index) => !index.primary).map((index) => index.name);
        expect(own.some((name) => name.toLowerCase().includes('staff_copy'))).toBe(true);
        const keys = await session.metadata.listForeignKeys(copy);
        expect(keys.map((key) => key.target.name)).toEqual([place.reported('staff_copy')]);
        const original = await session.metadata.listForeignKeys({
          ...place.scope,
          name: place.reported('staff'),
        });
        expect(original.map((key) => key.target.name)).toEqual([place.reported('staff')]);
      });
    });

    it.runIf(place.keys)('numbers new rows of the copy after the copied ones', async () => {
      await use(place, async (session) => {
        await runAll(
          session,
          `INSERT INTO ${place.name('staff_copy')} (name, boss) VALUES ('Dee', 1)`,
        );
        const ids = firstColumn(
          await runAll(session, `SELECT id FROM ${place.name('staff_copy')} WHERE name = 'Dee'`),
        ).map(Number);
        expect(ids).toEqual([4]);
      });
    });

    it('copies the structure alone when asked', async () => {
      await use(place, async (session) => {
        for (const statement of place.drop('staff_copy')) {
          await runAll(session, statement);
        }
      });
      const { report } = await duplicate(place, 'structure');
      expect(report.tables[0]).toMatchObject({ outcome: 'copied', created: true, rows: 0 });
      await use(place, async (session) => {
        expect(await count(session, place, 'staff_copy')).toBe(0);
      });
    });

    it('leaves a copy that is already there alone', async () => {
      const { report } = await duplicate(place);
      expect(report.tables[0]).toMatchObject({ outcome: 'skipped', created: false });
    });
  });
}
