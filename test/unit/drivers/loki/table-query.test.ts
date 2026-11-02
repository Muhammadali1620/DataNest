import { describe, expect, it } from 'vitest';
import { lokiDialect } from '../../../../src/drivers/loki/dialect';
import { translateTableQuery } from '../../../../src/drivers/loki/table-query';

describe('translateTableQuery', () => {
  it('turns the page of a label into a selector, newest first', () => {
    expect(translateTableQuery('SELECT * FROM `app` LIMIT 100')).toEqual({
      kind: 'rows',
      selector: '{app=~".+"}',
      direction: 'backward',
      limit: 100,
      offset: 0,
    });
  });

  it('keeps the offset of a later page', () => {
    expect(translateTableQuery('SELECT * FROM `app` LIMIT 100 OFFSET 300')).toMatchObject({
      limit: 100,
      offset: 300,
    });
  });

  it('sorts by time upwards when the grid says so, and downwards otherwise', () => {
    expect(translateTableQuery('SELECT * FROM `app` ORDER BY `time` ASC LIMIT 5')).toMatchObject({
      direction: 'forward',
    });
    expect(translateTableQuery('SELECT * FROM `app` ORDER BY `time` DESC LIMIT 5')).toMatchObject({
      direction: 'backward',
    });
    expect(translateTableQuery('SELECT * FROM `app` ORDER BY `ns`')).toMatchObject({
      direction: 'backward',
    });
  });

  it('reads the count of a label', () => {
    expect(translateTableQuery('SELECT COUNT(*) FROM `app`')).toEqual({
      kind: 'count',
      selector: '{app=~".+"}',
      direction: 'backward',
      offset: 0,
    });
    expect(translateTableQuery('select count ( * ) from `app`;')).toMatchObject({ kind: 'count' });
  });

  it('reads what the dialect writes, newlines and all', () => {
    const sql = lokiDialect.paginate(
      `SELECT * FROM ${lokiDialect.quoteTable({ name: 'level' })}\nORDER BY \`time\` DESC`,
      50,
      100,
    );
    expect(translateTableQuery(sql)).toMatchObject({
      selector: '{level=~".+"}',
      limit: 50,
      offset: 100,
    });
  });

  it('refuses a filter, saying how to filter a log', () => {
    expect(() =>
      translateTableQuery("SELECT * FROM `app` WHERE `line` LIKE '%x%' LIMIT 5"),
    ).toThrow(/Filters are not available for Loki/u);
    expect(() => translateTableQuery('SELECT COUNT(*) FROM `app` WHERE 1 = 1')).toThrow(
      /Filters are not available/u,
    );
  });

  it('leaves everything else to the server', () => {
    for (const sql of [
      '{app="shop"}',
      'SELECT 1',
      'SELECT `line` FROM `app`',
      'SELECT * FROM app',
      'SELECT * FROM `app` GROUP BY `x`',
      'rate({app="shop"}[5m])',
    ]) {
      expect(translateTableQuery(sql), sql).toBeUndefined();
    }
  });

  it('does not make a selector of a name that is no label', () => {
    expect(translateTableQuery('SELECT * FROM `a b` LIMIT 5')).toBeUndefined();
    expect(translateTableQuery('SELECT * FROM `1x` LIMIT 5')).toBeUndefined();
    expect(translateTableQuery('SELECT * FROM `a"}{x` LIMIT 5')).toBeUndefined();
  });
});
