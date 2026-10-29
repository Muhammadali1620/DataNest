import { describe, expect, it } from 'vitest';
import {
  mapColumnType,
  mapDefault,
  neutralType,
  targetType,
} from '../../../../src/services/transfer/type-map';

describe('neutralType', () => {
  it('reads booleans, including the MySQL and bit spellings', () => {
    for (const type of ['boolean', 'bool', 'tinyint(1)', 'bit(1)']) {
      expect(neutralType(type, 'mysql'), type).toEqual({ kind: 'boolean' });
    }
  });

  it('reads integers by width and sign', () => {
    expect(neutralType('tinyint', 'mysql')).toEqual({ kind: 'integer', bytes: 1, unsigned: false });
    expect(neutralType('int unsigned', 'mysql')).toEqual({
      kind: 'integer',
      bytes: 4,
      unsigned: true,
    });
    expect(neutralType('smallserial', 'postgres')).toMatchObject({ bytes: 2 });
    expect(neutralType('bigint', 'postgres')).toMatchObject({ bytes: 8 });
    expect(neutralType('mediumint(9)', 'mysql')).toMatchObject({ bytes: 3 });
    expect(neutralType('year', 'mysql')).toMatchObject({ kind: 'integer', bytes: 2 });
    // SQLite stores every integer in eight bytes.
    expect(neutralType('INT', 'sqlite')).toMatchObject({ bytes: 8 });
  });

  it('reads decimals and floating point by database', () => {
    expect(neutralType('decimal(10,2)', 'mysql')).toEqual({
      kind: 'decimal',
      precision: 10,
      scale: 2,
    });
    expect(neutralType('numeric', 'postgres')).toEqual({ kind: 'decimal' });
    expect(neutralType('numeric(12)', 'postgres')).toEqual({
      kind: 'decimal',
      precision: 12,
      scale: 0,
    });
    expect(neutralType('money', 'postgres')).toEqual({ kind: 'decimal', precision: 19, scale: 4 });
    expect(neutralType('double precision', 'postgres')).toEqual({ kind: 'float', double: true });
    expect(neutralType('real', 'postgres')).toEqual({ kind: 'float', double: false });
    expect(neutralType('real', 'mysql')).toEqual({ kind: 'float', double: true });
    expect(neutralType('float', 'mysql')).toEqual({ kind: 'float', double: false });
    expect(neutralType('float', 'postgres')).toEqual({ kind: 'float', double: true });
    expect(neutralType('float(10)', 'postgres')).toEqual({ kind: 'float', double: false });
  });

  it('reads text of a length, fixed or varying, and long text', () => {
    expect(neutralType('varchar(40)', 'mysql')).toEqual({
      kind: 'string',
      length: 40,
      fixed: false,
    });
    expect(neutralType('character varying(9)', 'postgres')).toMatchObject({ length: 9 });
    expect(neutralType('character varying', 'postgres')).toEqual({ kind: 'text' });
    expect(neutralType('char(2)', 'mysql')).toEqual({ kind: 'string', length: 2, fixed: true });
    expect(neutralType('character(3)', 'postgres')).toMatchObject({ fixed: true, length: 3 });
    expect(neutralType('longtext', 'mysql')).toEqual({ kind: 'text' });
    expect(neutralType('citext', 'postgres')).toEqual({ kind: 'text' });
  });

  it('reads moments with and without a zone', () => {
    expect(neutralType('date', 'mysql')).toEqual({ kind: 'date' });
    expect(neutralType('time(3)', 'mysql')).toEqual({ kind: 'time' });
    expect(neutralType('time with time zone', 'postgres')).toEqual({ kind: 'time' });
    expect(neutralType('datetime(6)', 'mysql')).toEqual({
      kind: 'datetime',
      zone: false,
      precision: 6,
    });
    expect(neutralType('timestamp without time zone', 'postgres')).toEqual({
      kind: 'datetime',
      zone: false,
    });
    expect(neutralType('timestamp(3) with time zone', 'postgres')).toEqual({
      kind: 'datetime',
      zone: true,
      precision: 3,
    });
    expect(neutralType('timestamptz', 'postgres')).toMatchObject({ zone: true });
  });

  it('reads the rest, unknown types as text', () => {
    expect(neutralType('jsonb', 'postgres')).toEqual({ kind: 'json' });
    expect(neutralType('bytea', 'postgres')).toEqual({ kind: 'binary' });
    expect(neutralType('varbinary(16)', 'mysql')).toEqual({ kind: 'binary' });
    expect(neutralType('bit(8)', 'mysql')).toEqual({ kind: 'binary' });
    expect(neutralType('uuid', 'postgres')).toEqual({ kind: 'uuid' });
    expect(neutralType("enum('a','b')", 'mysql')).toEqual({ kind: 'enum', values: ['a', 'b'] });
    expect(neutralType('integer[]', 'postgres')).toEqual({ kind: 'text' });
    expect(neutralType('order_status', 'postgres')).toEqual({ kind: 'text' });
    expect(neutralType('inet', 'postgres')).toEqual({ kind: 'text' });
  });
});

describe('targetType', () => {
  it('writes MySQL types, keeping indexed columns indexable', () => {
    expect(targetType({ kind: 'boolean' }, 'mysql', false)).toEqual({
      type: 'tinyint',
      length: '1',
    });
    expect(targetType({ kind: 'integer', bytes: 8, unsigned: true }, 'mysql', false)).toEqual({
      type: 'bigint unsigned',
      length: '',
    });
    expect(targetType({ kind: 'text' }, 'mysql', false)).toEqual({ type: 'longtext', length: '' });
    expect(targetType({ kind: 'text' }, 'mysql', true)).toEqual({ type: 'varchar', length: '255' });
    expect(targetType({ kind: 'binary' }, 'mysql', true)).toEqual({
      type: 'varbinary',
      length: '255',
    });
    expect(targetType({ kind: 'string', length: 300, fixed: true }, 'mysql', false)).toEqual({
      type: 'varchar',
      length: '300',
    });
    expect(targetType({ kind: 'string', length: 20_000, fixed: false }, 'mysql', false).type).toBe(
      'longtext',
    );
    expect(targetType({ kind: 'decimal' }, 'mysql', false)).toEqual({
      type: 'decimal',
      length: '65,30',
    });
    expect(targetType({ kind: 'datetime', zone: true }, 'mysql', false)).toEqual({
      type: 'datetime',
      length: '6',
    });
    expect(targetType({ kind: 'uuid' }, 'mysql', false)).toEqual({ type: 'char', length: '36' });
    expect(targetType({ kind: 'enum', values: ["it's", 'b'] }, 'mysql', false)).toEqual({
      type: 'enum',
      length: "'it''s','b'",
    });
  });

  it('writes PostgreSQL types, widening unsigned integers', () => {
    expect(targetType({ kind: 'integer', bytes: 4, unsigned: true }, 'postgres', false).type).toBe(
      'bigint',
    );
    expect(targetType({ kind: 'integer', bytes: 8, unsigned: true }, 'postgres', false)).toEqual({
      type: 'numeric',
      length: '20,0',
    });
    expect(targetType({ kind: 'integer', bytes: 3, unsigned: false }, 'postgres', false).type).toBe(
      'integer',
    );
    expect(targetType({ kind: 'float', double: true }, 'postgres', false).type).toBe(
      'double precision',
    );
    expect(targetType({ kind: 'json' }, 'postgres', false).type).toBe('jsonb');
    expect(targetType({ kind: 'enum', values: ['a'] }, 'postgres', false).type).toBe('text');
    expect(targetType({ kind: 'datetime', zone: true, precision: 3 }, 'postgres', false)).toEqual({
      type: 'timestamp with time zone',
      length: '3',
    });
  });

  it('writes SQLite types by affinity', () => {
    expect(targetType({ kind: 'integer', bytes: 2, unsigned: false }, 'sqlite', false).type).toBe(
      'integer',
    );
    expect(targetType({ kind: 'json' }, 'sqlite', false).type).toBe('text');
    expect(targetType({ kind: 'binary' }, 'sqlite', false).type).toBe('blob');
    expect(targetType({ kind: 'decimal', precision: 9, scale: 2 }, 'sqlite', false)).toEqual({
      type: 'numeric',
      length: '9,2',
    });
  });
});

describe('mapColumnType', () => {
  it('keeps types between databases of one kind', () => {
    expect(mapColumnType('decimal(10,2) unsigned', 'mysql', 'mysql', false)).toEqual({
      type: 'decimal unsigned',
      length: '10,2',
    });
  });

  it('translates between kinds', () => {
    expect(mapColumnType('tinyint(1)', 'mysql', 'postgres', false)).toEqual({
      type: 'boolean',
      length: '',
    });
  });
});

describe('mapDefault', () => {
  const text = { kind: 'text' } as const;

  it('keeps defaults between databases of one kind', () => {
    expect(mapDefault('gen_random_uuid()', { kind: 'uuid' }, 'postgres', 'postgres')).toBe(
      'gen_random_uuid()',
    );
  });

  it('carries literals over, without PostgreSQL casts', () => {
    expect(mapDefault("'new'::character varying", text, 'postgres', 'mysql')).toBe("'new'");
    expect(mapDefault("'paid'::order_status", text, 'postgres', 'mysql')).toBe("'paid'");
    expect(
      mapDefault('0', { kind: 'integer', bytes: 4, unsigned: false }, 'mysql', 'postgres'),
    ).toBe('0');
    expect(mapDefault("('x')", text, 'mysql', 'sqlite')).toBe("'x'");
  });

  it('writes booleans in the words of the target', () => {
    expect(mapDefault('1', { kind: 'boolean' }, 'mysql', 'postgres')).toBe('TRUE');
    expect(mapDefault('false', { kind: 'boolean' }, 'postgres', 'mysql')).toBe('0');
    expect(mapDefault('maybe()', { kind: 'boolean' }, 'postgres', 'mysql')).toBeUndefined();
  });

  it('translates the current time, with the precision MySQL wants', () => {
    const moment = { kind: 'datetime', zone: false, precision: 6 } as const;
    expect(mapDefault('now()', moment, 'postgres', 'mysql')).toBe('CURRENT_TIMESTAMP(6)');
    expect(mapDefault('CURRENT_TIMESTAMP', moment, 'mysql', 'postgres')).toBe('CURRENT_TIMESTAMP');
    expect(mapDefault('CURRENT_DATE', { kind: 'date' }, 'postgres', 'sqlite')).toBe('CURRENT_DATE');
  });

  it('leaves out NULL and what only the source understands', () => {
    expect(mapDefault('NULL', text, 'mysql', 'postgres')).toBeUndefined();
    expect(mapDefault('uuid()', { kind: 'uuid' }, 'mysql', 'postgres')).toBeUndefined();
    expect(mapDefault("nextval('s'::regclass)", text, 'postgres', 'mysql')).toBeUndefined();
  });
});
