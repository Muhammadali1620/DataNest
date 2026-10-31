import { describe, expect, it } from 'vitest';
import { typeIcon } from '../../../../../webview/src/apps/result-grid/column-type';

describe('typeIcon', () => {
  it.each([
    ['integer', 'symbol-numeric'],
    ['BIGINT', 'symbol-numeric'],
    ['numeric(10,2)', 'symbol-numeric'],
    ['double precision', 'symbol-numeric'],
    ['Nullable(Int32)', 'symbol-numeric'],
    ['money', 'symbol-numeric'],
    ['bit varying', 'symbol-numeric'],
    ['text', 'symbol-string'],
    ['character varying(255)', 'symbol-string'],
    ['NVARCHAR(MAX)', 'symbol-string'],
    ['LowCardinality(String)', 'symbol-string'],
    ['timestamp with time zone', 'calendar'],
    ['datetime2', 'calendar'],
    ['interval', 'calendar'],
    ['year', 'calendar'],
    ['boolean', 'symbol-boolean'],
    ['uuid', 'symbol-key'],
    ['uniqueidentifier', 'symbol-key'],
    ["enum('a','b')", 'symbol-enum'],
    ['set', 'symbol-enum'],
    ['bytea', 'file-media'],
    ['varbinary(16)', 'file-media'],
    ['longblob', 'file-media'],
    ['jsonb', 'json'],
    ['Map(String, UInt8)', 'json'],
    ['point', 'globe'],
    ['geometry', 'globe'],
    ['integer[]', 'symbol-array'],
    ['_int4', 'symbol-array'],
    ['Array(String)', 'symbol-array'],
  ])('%s → %s', (type, icon) => {
    expect(typeIcon(type)).toBe(icon);
  });

  it('falls back to a plain field for an unknown or missing type', () => {
    expect(typeIcon(undefined)).toBe('symbol-field');
    expect(typeIcon('')).toBe('symbol-field');
    expect(typeIcon('hstore')).toBe('symbol-field');
  });
});
