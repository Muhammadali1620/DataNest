import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { orReplace, renameCreated } from '../../../../src/drivers/mysql/replace';

const { ddl } = mysqlDialect;
const PROC = 'CREATE DEFINER=`root`@`localhost` PROCEDURE `p`(IN a INT)\nBEGIN\n  SELECT a;\nEND';

describe('renameCreated', () => {
  it('renames the created object after its keyword, past DEFINER', () => {
    expect(renameCreated(PROC, 'PROCEDURE', 'p__x')).toBe(
      'CREATE DEFINER=`root`@`localhost` PROCEDURE `p__x`(IN a INT)\nBEGIN\n  SELECT a;\nEND',
    );
  });

  it('renames the name part of a qualified name and skips IF NOT EXISTS', () => {
    expect(
      renameCreated('CREATE FUNCTION IF NOT EXISTS shop.f() RETURNS INT RETURN 1', 'FUNCTION', 'g'),
    ).toBe('CREATE FUNCTION IF NOT EXISTS shop.`g`() RETURNS INT RETURN 1');
    expect(
      renameCreated(
        'CREATE TRIGGER `t` BEFORE INSERT ON x FOR EACH ROW SET @a = 1',
        'TRIGGER',
        'u',
      ),
    ).toBe('CREATE TRIGGER `u` BEFORE INSERT ON x FOR EACH ROW SET @a = 1');
  });

  it('gives up on text that does not create such an object', () => {
    expect(renameCreated('SELECT 1', 'PROCEDURE', 'x')).toBeUndefined();
    expect(renameCreated('CREATE TABLE t (a int)', 'PROCEDURE', 'x')).toBeUndefined();
    expect(renameCreated('CREATE PROCEDURE', 'PROCEDURE', 'x')).toBeUndefined();
    expect(renameCreated('CREATE PROCEDURE (', 'PROCEDURE', 'x')).toBeUndefined();
  });

  it('is not fooled by the keyword inside a comment or a string', () => {
    expect(
      renameCreated(
        "CREATE /* PROCEDURE */ FUNCTION f() RETURNS CHAR RETURN 'PROCEDURE'",
        'PROCEDURE',
        'x',
      ),
    ).toBeUndefined();
  });
});

describe('orReplace', () => {
  it('adds OR REPLACE once', () => {
    expect(orReplace('CREATE ALGORITHM=UNDEFINED VIEW v AS SELECT 1')).toBe(
      'CREATE OR REPLACE ALGORITHM=UNDEFINED VIEW v AS SELECT 1',
    );
    expect(orReplace('  create or replace view v as select 1')).toBe(
      '  create or replace view v as select 1',
    );
  });
});

describe('mysql replaceObject', () => {
  it('replaces a view in place, with nothing to restore', () => {
    expect(
      ddl.replaceObject({ kind: 'view', name: 'v' }, ['CREATE VIEW v AS SELECT 2'], []),
    ).toEqual({
      check: [],
      statements: ['CREATE OR REPLACE VIEW v AS SELECT 2'],
      recovery: [],
    });
  });

  it('tries a routine out under a scratch name, then drops and creates it, restoring on failure', () => {
    const plan = ddl.replaceObject(
      { database: 'shop', kind: 'procedure', name: 'p' },
      [PROC],
      ['OLD'],
    );
    expect(plan).toEqual({
      check: [
        'CREATE DEFINER=`root`@`localhost` PROCEDURE `p__datanest_check`(IN a INT)\nBEGIN\n  SELECT a;\nEND',
        'DROP PROCEDURE IF EXISTS `shop`.`p__datanest_check`',
      ],
      statements: ['DROP PROCEDURE IF EXISTS `shop`.`p`', PROC],
      recovery: ['DROP PROCEDURE IF EXISTS `shop`.`p`', 'OLD'],
    });
  });

  it('does not try out an event, nor text of several statements', () => {
    expect(
      ddl.replaceObject(
        { kind: 'event', name: 'e' },
        ['CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT 1'],
        [],
      ).check,
    ).toEqual([]);
    expect(
      ddl.replaceObject({ kind: 'trigger', name: 't' }, ['CREATE TRIGGER t …', 'SELECT 1'], [])
        .check,
    ).toEqual([]);
  });

  it('refuses tables and sequences', () => {
    for (const kind of ['table', 'sequence'] as const) {
      expect(() => ddl.replaceObject({ kind, name: 'x' }, [], [])).toThrow(
        expect.objectContaining({ code: 'unsupported' }),
      );
    }
  });
});
