import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { mysqlDump, withoutDefiner } from '../../../../src/drivers/mysql/dump';

describe('mysqlDump', () => {
  it('is the dump part of the MySQL dialect', () => {
    expect(mysqlDialect.dump).toBe(mysqlDump);
  });

  it('reads in UTC inside a consistent snapshot', () => {
    expect(mysqlDump.prepare).toContain("SET time_zone = '+00:00'");
    expect(mysqlDump.beginSnapshot).toEqual(['START TRANSACTION WITH CONSISTENT SNAPSHOT']);
    expect(mysqlDump.endSnapshot).toEqual(['ROLLBACK']);
  });

  it('turns checks off in the header and puts every setting back in the footer', () => {
    const saved = mysqlDump.header.flatMap((sql) =>
      [...sql.matchAll(/@(OLD_\w+)/gu)].map((m) => m[1]),
    );
    expect(saved.sort()).toEqual(
      ['OLD_FOREIGN_KEY_CHECKS', 'OLD_SQL_MODE', 'OLD_TIME_ZONE', 'OLD_UNIQUE_CHECKS'].sort(),
    );
    for (const name of saved) {
      expect(
        mysqlDump.footer.some((sql) => sql.includes(`@${name ?? ''}`)),
        name,
      ).toBe(true);
    }
    expect(mysqlDump.header.join('\n')).toContain('FOREIGN_KEY_CHECKS = 0');
    expect(mysqlDump.header.join('\n')).toContain("SQL_MODE = 'NO_AUTO_VALUE_ON_ZERO'");
  });

  it('writes several rows into one INSERT and ignores identity', () => {
    expect(mysqlDump.insert('`t`', ['`a`', '`b`'], ['(1, 2)', '(3, 4)'], true)).toBe(
      'INSERT INTO `t` (`a`, `b`) VALUES\n(1, 2),\n(3, 4)',
    );
    expect(mysqlDump.resetSequence).toBeUndefined();
  });

  it('drops tables and views in one statement each', () => {
    expect(mysqlDump.dropRelations([{ name: 'a' }, { name: 'b`c' }], 'table')).toEqual([
      'DROP TABLE IF EXISTS `a`, `b``c`',
    ]);
    expect(mysqlDump.dropRelations([{ name: 'v' }], 'view')).toEqual(['DROP VIEW IF EXISTS `v`']);
    expect(mysqlDump.dropRelations([], 'table')).toEqual([]);
  });

  it('drops other objects by kind', () => {
    expect(mysqlDump.dropObject({ kind: 'procedure', name: 'p' })).toBe(
      'DROP PROCEDURE IF EXISTS `p`',
    );
    expect(mysqlDump.dropObject({ kind: 'event', name: 'e', database: 'db' })).toBe(
      'DROP EVENT IF EXISTS `db`.`e`',
    );
    expect(mysqlDump.dropObject({ kind: 'sequence', name: 's' })).toBe(
      'DROP SEQUENCE IF EXISTS `s`',
    );
    expect(mysqlDump.dropObject({ kind: 'view', name: 'v' })).toBe('DROP VIEW IF EXISTS `v`');
  });
});

describe('withoutDefiner', () => {
  it('drops the DEFINER clause of views, routines, triggers and events', () => {
    expect(
      withoutDefiner(
        'CREATE ALGORITHM=UNDEFINED DEFINER=`root`@`localhost` SQL SECURITY DEFINER VIEW `v` AS select 1',
      ),
    ).toBe('CREATE ALGORITHM=UNDEFINED SQL SECURITY DEFINER VIEW `v` AS select 1');
    expect(withoutDefiner('CREATE DEFINER=`a``b`@`%` PROCEDURE `p`() BEGIN END')).toBe(
      'CREATE PROCEDURE `p`() BEGIN END',
    );
    expect(withoutDefiner("CREATE DEFINER='admin'@'10.0.%' TRIGGER t")).toBe('CREATE TRIGGER t');
    expect(withoutDefiner('CREATE DEFINER=CURRENT_USER EVENT e')).toBe('CREATE EVENT e');
    expect(withoutDefiner('create definer = `x`@`y` function f() returns int return 1')).toBe(
      'create function f() returns int return 1',
    );
  });

  it('leaves everything else alone', () => {
    const table = "CREATE TABLE `t` (`definer` int, note text DEFAULT 'DEFINER=x')";
    expect(withoutDefiner(table)).toBe(table);
    expect(withoutDefiner("SELECT 'CREATE DEFINER=`a`@`b` VIEW'")).toBe(
      "SELECT 'CREATE DEFINER=`a`@`b` VIEW'",
    );
  });
});
