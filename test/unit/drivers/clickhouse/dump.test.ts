import { describe, expect, it } from 'vitest';
import { clickhouseDump } from '../../../../src/drivers/clickhouse/dump';

describe('clickhouseDump', () => {
  it('copies rows inside the database with INSERT … SELECT (V10.2.3)', () => {
    expect(clickhouseDump.insertSelect('`t`', ['`a`'], 'SELECT `a` FROM `s`', false)).toBe(
      'INSERT INTO `t` (`a`)\nSELECT `a` FROM `s`',
    );
    expect(clickhouseDump.insertSelect('`t`', ['`a`'], 'SELECT `a` FROM `s`', true)).toBe(
      'INSERT INTO `t` (`a`)\nSELECT `a` FROM `s`',
    );
  });

  it('needs no snapshot, header, footer or later keys', () => {
    expect(clickhouseDump).toMatchObject({
      prepare: [],
      beginSnapshot: [],
      endSnapshot: [],
      header: [],
      footer: [],
      keysAfterData: false,
      routinesFirst: false,
    });
    expect(clickhouseDump.resetSequence).toBeUndefined();
    expect(clickhouseDump.createSchema).toBeUndefined();
  });

  it('writes rows as one INSERT … VALUES, the same with or without identity', () => {
    const insert = clickhouseDump.insert('`t`', ['`a`', '`b`'], ["(1, 'x')", "(2, 'y')"], false);
    expect(insert).toBe("INSERT INTO `t` (`a`, `b`) VALUES\n(1, 'x'),\n(2, 'y')");
    expect(clickhouseDump.insert('`t`', ['`a`'], ['(1)'], true)).toBe(
      'INSERT INTO `t` (`a`) VALUES\n(1)',
    );
  });

  it('drops each relation in a statement of its own', () => {
    expect(
      clickhouseDump.dropRelations([{ name: 'a' }, { database: 'd', name: 'b' }], 'table'),
    ).toEqual(['DROP TABLE IF EXISTS `a`', 'DROP TABLE IF EXISTS `d`.`b`']);
    expect(clickhouseDump.dropRelations([{ name: 'v' }], 'view')).toEqual([
      'DROP VIEW IF EXISTS `v`',
    ]);
    expect(clickhouseDump.dropRelations([{ name: 'm' }], 'materialized-view')).toEqual([
      'DROP VIEW IF EXISTS `m`',
    ]);
    expect(clickhouseDump.dropRelations([], 'table')).toEqual([]);
  });

  it('drops tables and views, and has nothing else to drop', () => {
    expect(clickhouseDump.dropObject({ kind: 'table', name: 't' })).toBe(
      'DROP TABLE IF EXISTS `t`',
    );
    expect(clickhouseDump.dropObject({ kind: 'view', name: 'v' })).toBe('DROP VIEW IF EXISTS `v`');
    for (const kind of ['function', 'procedure', 'trigger', 'sequence', 'event'] as const) {
      expect(() => clickhouseDump.dropObject({ kind, name: 'x' })).toThrow(/no /u);
    }
  });
});
