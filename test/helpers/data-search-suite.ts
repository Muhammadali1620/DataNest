// The checks of "Find Data…" (V10.2.6) every SQL server goes through: case is ignored,
// LIKE's own characters in the text are taken literally, numbers are not searched, and
// the condition of a hit finds exactly the rows it counted.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectScope } from '../../src/core/model/objects';
import type { Driver, Session } from '../../src/drivers/driver';
import { searchData } from '../../src/services/data-search';
import type { ResolvedConnectionConfig, SqlDriverId } from '../../src/shared/connection';
import { firstColumn, runAll } from './driver-run';

export interface DataSearchPlace {
  readonly label: string;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  readonly id: SqlDriverId;
  readonly scope: ObjectScope;
  /** Make `find_me` (id, note text, title short text, n number) with the six rows below. */
  readonly create: readonly string[];
  readonly drop: readonly string[];
  /** How SQL in the test names the table. */
  readonly name: string;
  /** As the server reports it (Oracle: upper case). */
  readonly reported: (name: string) => string;
}

/** The rows every place holds: note, title. */
export const SEARCH_ROWS: readonly (readonly [string | null, string])[] = [
  ['Ann Lee called', 'first'],
  ['the 50%_off! deal', 'second'],
  ['nothing here', 'ANN again'],
  ['xzy', 'third'],
  [null, 'fourth'],
  ['ann', 'ann'],
];

export function dataSearchSuite(place: DataSearchPlace): void {
  describe(`Find Data on ${place.label}`, () => {
    let session: Session;

    beforeAll(async () => {
      session = await place.driver().openSession(place.config());
      for (const statement of [...place.drop, ...place.create]) {
        await runAll(session, statement);
      }
    });

    afterAll(async () => {
      for (const statement of place.drop) {
        await runAll(session, statement);
      }
      await session.close();
    });

    async function find(text: string) {
      const report = await searchData({
        session,
        dialect: place.driver().dialect,
        driver: place.id,
        scope: place.scope,
        text,
      });
      expect(report.failures).toEqual([]);
      return report.hits.find((hit) => hit.table.name === place.reported('find_me'));
    }

    it('finds the text in every text column, whatever its case', async () => {
      const hit = await find('ann');
      expect(hit?.rows).toBe(3);
      const columns = Object.fromEntries(
        (hit?.columns ?? []).map((column) => [column.name.toLowerCase(), column.rows]),
      );
      expect(columns).toEqual({ note: 2, title: 2 });
    });

    it('takes %, _ and ! in the text as themselves', async () => {
      expect((await find('50%_off!'))?.rows).toBe(1);
      expect(await find('x_y')).toBeUndefined();
      expect(await find('%')).toMatchObject({ rows: 1 });
    });

    it('finds nothing where nothing holds the text, and leaves numbers alone', async () => {
      expect(await find('no such words anywhere')).toBeUndefined();
      expect(await find('42')).toBeUndefined();
    });

    it('gives a condition that finds exactly the rows it counted', async () => {
      const hit = await find('ANN');
      const counted = await runAll(
        session,
        `SELECT COUNT(*) FROM ${place.name} WHERE ${hit?.where ?? '1 = 0'}`,
      );
      expect(Number(firstColumn(counted)[0])).toBe(hit?.rows);
    });
  });
}
