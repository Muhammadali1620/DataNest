import { describe, expect, it } from 'vitest';
import type { ObjectKind } from '../../../../src/core/model/objects';
import { readMysqlDefinition } from '../../../../src/drivers/mysql/definitions';

/** A reader that records statements and answers with fixed rows. */
function reader(rows: unknown[][]) {
  const statements: string[] = [];
  return {
    statements,
    read: (sql: string) => {
      statements.push(sql);
      return Promise.resolve(rows);
    },
  };
}

describe('readMysqlDefinition', () => {
  it.each([
    ['table', 'SHOW CREATE TABLE `shop`.`orders`', ['orders', 'CREATE TABLE x']],
    ['view', 'SHOW CREATE VIEW `shop`.`orders`', ['orders', 'CREATE VIEW x', 'utf8', 'c']],
    [
      'procedure',
      'SHOW CREATE PROCEDURE `shop`.`orders`',
      ['orders', 'mode', 'CREATE PROCEDURE x'],
    ],
    ['function', 'SHOW CREATE FUNCTION `shop`.`orders`', ['orders', 'mode', 'CREATE FUNCTION x']],
    ['trigger', 'SHOW CREATE TRIGGER `shop`.`orders`', ['orders', 'mode', 'CREATE TRIGGER x']],
    ['event', 'SHOW CREATE EVENT `shop`.`orders`', ['orders', 'mode', 'tz', 'CREATE EVENT x']],
  ] as [ObjectKind, string, unknown[]][])(
    'reads a %s from its own column of SHOW CREATE',
    async (kind, statement, row) => {
      const fake = reader([row]);
      const result = await readMysqlDefinition(fake.read, {
        database: 'shop',
        kind,
        name: 'orders',
      });
      expect(fake.statements).toEqual([statement]);
      expect(result).toEqual([`CREATE ${kind === 'table' ? 'TABLE' : kind.toUpperCase()} x`]);
    },
  );

  it('uses the session database when the reference has none', async () => {
    const fake = reader([['t', 'CREATE TABLE t']]);
    await readMysqlDefinition(fake.read, { kind: 'table', name: 't' });
    expect(fake.statements).toEqual(['SHOW CREATE TABLE `t`']);
  });

  it('quotes backticks in names', async () => {
    const fake = reader([['t', 'CREATE TABLE t']]);
    await readMysqlDefinition(fake.read, { database: 'a`b', kind: 'table', name: 'x`; DROP' });
    expect(fake.statements).toEqual(['SHOW CREATE TABLE `a``b`.`x``; DROP`']);
  });

  it('says not-found when the server returns no row', async () => {
    await expect(
      readMysqlDefinition(reader([]).read, { kind: 'view', name: 'v' }),
    ).rejects.toMatchObject({ code: 'not-found', message: 'v does not exist' });
  });

  it('says permission-denied when the server hides the text', async () => {
    for (const hidden of [null, '']) {
      await expect(
        readMysqlDefinition(reader([['p', 'mode', hidden]]).read, {
          kind: 'procedure',
          name: 'p',
        }),
      ).rejects.toMatchObject({ code: 'permission-denied' });
    }
  });

  it('lets a server error through', async () => {
    const failing = () => Promise.reject(new Error('gone'));
    await expect(readMysqlDefinition(failing, { kind: 'table', name: 't' })).rejects.toThrow(
      'gone',
    );
  });
});
