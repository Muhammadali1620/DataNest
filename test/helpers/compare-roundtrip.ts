// The round trip every server goes through in a schema comparison (V8.3): the
// differences between two schemas, then the script run on the target, then nothing
// left to change.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectScope } from '../../src/core/model/objects';
import { splitStatements } from '../../src/core/sql/split';
import type { Driver, Session } from '../../src/drivers/driver';
import { compareSchemas } from '../../src/services/schema-compare/compare';
import { migrationScript } from '../../src/services/schema-compare/migration';
import { readSchemaSnapshot } from '../../src/services/schema-compare/snapshot';
import type { DriverId, ResolvedConnectionConfig } from '../../src/shared/connection';
import { runAll } from './driver-run';

export interface CompareSide {
  readonly config: () => ResolvedConnectionConfig;
  readonly scope: ObjectScope;
  readonly setup: readonly string[];
}

export interface CompareTarget {
  readonly label: string;
  readonly driverId: DriverId;
  readonly driver: () => Driver;
  readonly source: CompareSide;
  readonly target: CompareSide;
  readonly teardown: readonly string[];
}

/**
 * Both sides hold `customers` (different columns), `orders` (a key and an index only in
 * the source), `big_orders` (another condition); `notes` is only in the source and
 * `legacy` only in the target.
 */
export function compareRoundTrip(target: CompareTarget): void {
  describe(`schema comparison on ${target.label}`, () => {
    let source: Session;
    let destination: Session;
    const driver = (): Driver => target.driver();

    beforeAll(async () => {
      source = await driver().openSession(target.source.config());
      for (const sql of target.source.setup) {
        await runAll(source, sql);
      }
      destination = await driver().openSession(target.target.config());
      for (const sql of target.target.setup) {
        await runAll(destination, sql);
      }
    }, 60_000);

    afterAll(async () => {
      for (const sql of target.teardown) {
        await runAll(destination, sql);
      }
      await source.close();
      await destination.close();
    });

    const snapshot = async (session: Session, scope: ObjectScope) =>
      await readSchemaSnapshot(session.metadata, scope, {
        kinds: driver().capabilities.objectKinds,
        ...(driver().dialect.dump.portable === undefined
          ? {}
          : { portable: driver().dialect.dump.portable }),
      });
    const compare = async () =>
      compareSchemas(
        await snapshot(source, target.source.scope),
        await snapshot(destination, target.target.scope),
        { driver: target.driverId, quote: (name) => driver().dialect.quoteIdentifier(name) },
      );

    it('finds new, different and removed tables and views', async () => {
      const items = await compare();
      const status = Object.fromEntries(
        items.map((item) => [`${item.kind}:${item.name}`, item.status]),
      );
      expect(status).toMatchObject({
        'table:customers': 'changed',
        'table:orders': 'changed',
        'table:notes': 'added',
        'table:legacy': 'removed',
        'view:big_orders': 'changed',
      });
      const customers = items.find((item) => item.kind === 'table' && item.name === 'customers');
      if (customers?.kind !== 'table') {
        throw new Error('no customers');
      }
      expect(customers.diff?.added.map((column) => column.name)).toEqual(['email']);
      expect(customers.diff?.dropped.map((column) => column.name)).toEqual(['phone']);
      expect(customers.diff?.changed.map((change) => change.after.name)).toEqual(['name']);
    });

    it('writes a script that makes the target like the source', async () => {
      const items = (await compare()).filter((item) => item.status !== 'same');
      const script = migrationScript({
        items,
        dialect: driver().dialect,
        driver: target.driverId,
        target: target.target.scope,
        sourceLabel: 'source',
        targetLabel: 'target',
        date: new Date(0),
      });
      for (const statement of splitStatements(script, target.driverId)) {
        await runAll(destination, statement.text);
      }
      const after = await compare();

      expect(
        after
          .filter((item) => item.status !== 'same')
          .map((item) => `${item.kind}:${item.name}:${item.status}`),
      ).toEqual([]);
    });
  });
}
