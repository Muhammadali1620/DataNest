import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEMA,
  flag,
  objectName,
  optionalText,
  schemaOf,
  text,
  unwrapDefault,
} from '../../../../src/drivers/mssql/catalog';

describe('unwrapDefault', () => {
  it('drops the parentheses the server wraps a default in', () => {
    expect(unwrapDefault('((0))')).toBe('0');
    expect(unwrapDefault("('new')")).toBe("'new'");
    expect(unwrapDefault('(getdate())')).toBe('getdate()');
    expect(unwrapDefault(' ((1)) ')).toBe('1');
  });

  it('keeps parentheses that do not wrap the whole text', () => {
    expect(unwrapDefault('((1)+(2))')).toBe('(1)+(2)');
    expect(unwrapDefault('(1)+(2)')).toBe('(1)+(2)');
    expect(unwrapDefault('getdate()')).toBe('getdate()');
  });

  it('is not fooled by parentheses inside strings or brackets', () => {
    expect(unwrapDefault("(')(')")).toBe("')('");
    expect(unwrapDefault("('it''s (x)')")).toBe("'it''s (x)'");
    expect(unwrapDefault('([a)b])')).toBe('[a)b]');
  });

  it('leaves unbalanced text alone', () => {
    expect(unwrapDefault('((0)')).toBe('((0)');
    expect(unwrapDefault('')).toBe('');
  });
});

describe('catalog helpers', () => {
  it('defaults the schema to dbo', () => {
    expect(DEFAULT_SCHEMA).toBe('dbo');
    expect(schemaOf({})).toBe('dbo');
    expect(schemaOf({ schema: 'sales' })).toBe('sales');
  });

  it('gives OBJECT_ID a quoted two-part name', () => {
    expect(objectName({ name: 'o]rders' })).toBe('[dbo].[o]]rders]');
    expect(objectName({ schema: 'inventory', name: 'stock' })).toBe('[inventory].[stock]');
  });

  it('reads catalog cells', () => {
    expect(text(null)).toBe('');
    expect(text('x')).toBe('x');
    expect(optionalText(null)).toBeUndefined();
    expect(optionalText(3)).toBe('3');
    expect(flag(true)).toBe(true);
    expect(flag(1)).toBe(true);
    expect(flag(0)).toBe(false);
    expect(flag('1')).toBe(false);
    expect(flag(null)).toBe(false);
  });
});
