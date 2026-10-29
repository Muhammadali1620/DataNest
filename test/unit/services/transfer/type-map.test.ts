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

describe('SQL Server types (V6.2)', () => {
  it('reads the types that mean something else in SQL Server', () => {
    expect(neutralType('bit', 'mssql')).toEqual({ kind: 'boolean' });
    expect(neutralType('tinyint', 'mssql')).toEqual({ kind: 'integer', bytes: 1, unsigned: true });
    expect(neutralType('real', 'mssql')).toEqual({ kind: 'float', double: false });
    expect(neutralType('float', 'mssql')).toEqual({ kind: 'float', double: true });
    expect(neutralType('float(24)', 'mssql')).toEqual({ kind: 'float', double: false });
    expect(neutralType('float(53)', 'mssql')).toEqual({ kind: 'float', double: true });
    expect(neutralType('timestamp', 'mssql')).toEqual({ kind: 'binary' });
    expect(neutralType('rowversion', 'mssql')).toEqual({ kind: 'binary' });
    expect(neutralType('image', 'mssql')).toEqual({ kind: 'binary' });
    expect(neutralType('smallmoney', 'mssql')).toEqual({
      kind: 'decimal',
      precision: 10,
      scale: 4,
    });
    expect(neutralType('money', 'mssql')).toEqual({ kind: 'decimal', precision: 19, scale: 4 });
    expect(neutralType('ntext', 'mssql')).toEqual({ kind: 'text' });
    expect(neutralType('xml', 'mssql')).toEqual({ kind: 'text' });
    expect(neutralType('sysname', 'mssql')).toEqual({ kind: 'text' });
  });

  it('reads SQL Server moments with and without an offset', () => {
    expect(neutralType('datetimeoffset(7)', 'mssql')).toEqual({
      kind: 'datetime',
      zone: true,
      precision: 6,
    });
    expect(neutralType('datetimeoffset', 'mssql')).toEqual({ kind: 'datetime', zone: true });
    expect(neutralType('datetime2(3)', 'mssql')).toEqual({
      kind: 'datetime',
      zone: false,
      precision: 3,
    });
    expect(neutralType('datetime', 'mssql')).toEqual({
      kind: 'datetime',
      zone: false,
      precision: 3,
    });
    expect(neutralType('smalldatetime', 'mssql')).toEqual({
      kind: 'datetime',
      zone: false,
      precision: 0,
    });
    expect(neutralType('time(7)', 'mssql')).toEqual({ kind: 'time' });
    expect(neutralType('date', 'mssql')).toEqual({ kind: 'date' });
  });

  it('reads strings of every length, max among them', () => {
    expect(neutralType('nvarchar(50)', 'mssql')).toEqual({
      kind: 'string',
      length: 50,
      fixed: false,
    });
    expect(neutralType('nvarchar(max)', 'mssql')).toEqual({ kind: 'text' });
    expect(neutralType('nchar(3)', 'mssql')).toEqual({ kind: 'string', length: 3, fixed: true });
    expect(neutralType('varbinary(max)', 'mssql')).toEqual({ kind: 'binary' });
    expect(neutralType('uniqueidentifier', 'mssql')).toEqual({ kind: 'uuid' });
  });

  it('keeps MySQL bit and PostgreSQL real as they were', () => {
    expect(neutralType('bit', 'mysql')).toEqual({ kind: 'binary' });
    expect(neutralType('real', 'postgres')).toEqual({ kind: 'float', double: false });
    expect(neutralType('real', 'mysql')).toEqual({ kind: 'float', double: true });
    expect(neutralType('tinyint', 'mysql')).toEqual({ kind: 'integer', bytes: 1, unsigned: false });
  });

  it('writes every neutral kind in SQL Server words', () => {
    const to = (neutral: Parameters<typeof targetType>[0], indexed = false) =>
      targetType(neutral, 'mssql', indexed);
    expect(to({ kind: 'boolean' })).toEqual({ type: 'bit', length: '' });
    expect(to({ kind: 'integer', bytes: 1, unsigned: true })).toEqual({
      type: 'tinyint',
      length: '',
    });
    expect(to({ kind: 'integer', bytes: 1, unsigned: false })).toEqual({
      type: 'smallint',
      length: '',
    });
    expect(to({ kind: 'integer', bytes: 2, unsigned: false })).toEqual({
      type: 'smallint',
      length: '',
    });
    expect(to({ kind: 'integer', bytes: 2, unsigned: true })).toEqual({ type: 'int', length: '' });
    expect(to({ kind: 'integer', bytes: 3, unsigned: false })).toEqual({ type: 'int', length: '' });
    expect(to({ kind: 'integer', bytes: 4, unsigned: false })).toEqual({ type: 'int', length: '' });
    expect(to({ kind: 'integer', bytes: 4, unsigned: true })).toEqual({
      type: 'bigint',
      length: '',
    });
    expect(to({ kind: 'integer', bytes: 8, unsigned: false })).toEqual({
      type: 'bigint',
      length: '',
    });
    expect(to({ kind: 'integer', bytes: 8, unsigned: true })).toEqual({
      type: 'decimal',
      length: '20,0',
    });
    expect(to({ kind: 'decimal' })).toEqual({ type: 'decimal', length: '38,10' });
    expect(to({ kind: 'decimal', precision: 65, scale: 40 })).toEqual({
      type: 'decimal',
      length: '38,38',
    });
    expect(to({ kind: 'decimal', precision: 10, scale: 2 })).toEqual({
      type: 'decimal',
      length: '10,2',
    });
    expect(to({ kind: 'float', double: true })).toEqual({ type: 'float', length: '' });
    expect(to({ kind: 'float', double: false })).toEqual({ type: 'real', length: '' });
    expect(to({ kind: 'string', length: 40, fixed: false })).toEqual({
      type: 'nvarchar',
      length: '40',
    });
    expect(to({ kind: 'string', length: 2, fixed: true })).toEqual({ type: 'nchar', length: '2' });
    expect(to({ kind: 'string', length: 9000, fixed: false })).toEqual({
      type: 'nvarchar',
      length: 'max',
    });
    expect(to({ kind: 'string', length: 9000, fixed: false }, true)).toEqual({
      type: 'nvarchar',
      length: '450',
    });
    expect(to({ kind: 'text' })).toEqual({ type: 'nvarchar', length: 'max' });
    expect(to({ kind: 'text' }, true)).toEqual({ type: 'nvarchar', length: '450' });
    expect(to({ kind: 'json' })).toEqual({ type: 'nvarchar', length: 'max' });
    expect(to({ kind: 'enum', values: ['new', 'shipped'] })).toEqual({
      type: 'nvarchar',
      length: '7',
    });
    expect(to({ kind: 'enum', values: [] })).toEqual({ type: 'nvarchar', length: '255' });
    expect(to({ kind: 'date' })).toEqual({ type: 'date', length: '' });
    expect(to({ kind: 'time' })).toEqual({ type: 'time', length: '' });
    expect(to({ kind: 'datetime', zone: false })).toEqual({ type: 'datetime2', length: '7' });
    expect(to({ kind: 'datetime', zone: true, precision: 3 })).toEqual({
      type: 'datetimeoffset',
      length: '3',
    });
    expect(to({ kind: 'binary' })).toEqual({ type: 'varbinary', length: 'max' });
    expect(to({ kind: 'binary' }, true)).toEqual({ type: 'varbinary', length: '900' });
    expect(to({ kind: 'uuid' })).toEqual({ type: 'uniqueidentifier', length: '' });
  });

  it('carries types across: PostgreSQL to SQL Server and back', () => {
    expect(mapColumnType('timestamp with time zone', 'postgres', 'mssql', false)).toEqual({
      type: 'datetimeoffset',
      length: '7',
    });
    expect(mapColumnType('boolean', 'postgres', 'mssql', false)).toEqual({
      type: 'bit',
      length: '',
    });
    expect(mapColumnType('bit', 'mssql', 'postgres', false)).toEqual({
      type: 'boolean',
      length: '',
    });
    expect(mapColumnType('tinyint', 'mssql', 'mysql', false)).toEqual({
      type: 'tinyint unsigned',
      length: '',
    });
    expect(mapColumnType('nvarchar(max)', 'mssql', 'mssql', false)).toEqual({
      type: 'nvarchar',
      length: 'max',
    });
  });

  it('carries defaults to SQL Server', () => {
    const datetime = { kind: 'datetime', zone: false } as const;
    expect(mapDefault('true', { kind: 'boolean' }, 'postgres', 'mssql')).toBe('1');
    expect(mapDefault('false', { kind: 'boolean' }, 'postgres', 'mssql')).toBe('0');
    expect(mapDefault('now()', datetime, 'postgres', 'mssql')).toBe('SYSDATETIME()');
    expect(
      mapDefault('CURRENT_TIMESTAMP', { kind: 'datetime', zone: true }, 'mysql', 'mssql'),
    ).toBe('SYSDATETIMEOFFSET()');
    expect(mapDefault('CURRENT_DATE', { kind: 'date' }, 'postgres', 'mssql')).toBe(
      'CAST(GETDATE() AS date)',
    );
    expect(mapDefault("'new'::character varying", { kind: 'text' }, 'postgres', 'mssql')).toBe(
      "'new'",
    );
    expect(
      mapDefault(
        "nextval('s'::regclass)",
        { kind: 'integer', bytes: 4, unsigned: false },
        'postgres',
        'mssql',
      ),
    ).toBeUndefined();
  });

  it('carries SQL Server defaults elsewhere: N strings, getdate() and bit values', () => {
    const datetime = { kind: 'datetime', zone: false } as const;
    expect(mapDefault("N'new'", { kind: 'text' }, 'mssql', 'postgres')).toBe("'new'");
    expect(mapDefault('getdate()', datetime, 'mssql', 'postgres')).toBe('CURRENT_TIMESTAMP');
    expect(mapDefault('sysdatetime()', datetime, 'mssql', 'mysql')).toBe('CURRENT_TIMESTAMP(6)');
    expect(mapDefault('1', { kind: 'boolean' }, 'mssql', 'postgres')).toBe('TRUE');
    expect(mapDefault('newid()', { kind: 'uuid' }, 'mssql', 'postgres')).toBeUndefined();
    expect(mapDefault('NULL', { kind: 'text' }, 'mssql', 'postgres')).toBeUndefined();
  });
});

describe('ClickHouse as the source (V6.3)', () => {
  const read = (type: string) => neutralType(type, 'clickhouse');

  it('reads integers by their width, wide ones as decimals', () => {
    expect(read('Int8')).toEqual({ kind: 'integer', bytes: 1, unsigned: false });
    expect(read('UInt16')).toEqual({ kind: 'integer', bytes: 2, unsigned: true });
    expect(read('UInt32')).toEqual({ kind: 'integer', bytes: 4, unsigned: true });
    expect(read('Int64')).toEqual({ kind: 'integer', bytes: 8, unsigned: false });
    expect(read('Int128')).toEqual({ kind: 'decimal', precision: 39, scale: 0 });
    expect(read('UInt256')).toEqual({ kind: 'decimal', precision: 77, scale: 0 });
  });

  it('looks through Nullable and LowCardinality', () => {
    expect(read('Nullable(UInt8)')).toEqual({ kind: 'integer', bytes: 1, unsigned: true });
    expect(read('LowCardinality(Nullable(String))')).toEqual({ kind: 'text' });
    expect(read('Nullable(Decimal(10, 2))')).toEqual({ kind: 'decimal', precision: 10, scale: 2 });
  });

  it('reads decimals, floats, booleans and fixed strings', () => {
    expect(read('Decimal(18, 4)')).toEqual({ kind: 'decimal', precision: 18, scale: 4 });
    expect(read('Decimal(9)')).toEqual({ kind: 'decimal', precision: 9, scale: 0 });
    expect(read('Decimal32(3)')).toEqual({ kind: 'decimal', precision: 9, scale: 3 });
    expect(read('Decimal128(10)')).toEqual({ kind: 'decimal', precision: 38, scale: 10 });
    expect(read('Float32')).toEqual({ kind: 'float', double: false });
    expect(read('Float64')).toEqual({ kind: 'float', double: true });
    expect(read('Bool')).toEqual({ kind: 'boolean' });
    expect(read('FixedString(3)')).toEqual({ kind: 'string', length: 3, fixed: true });
    expect(read('String')).toEqual({ kind: 'text' });
  });

  it('reads dates and times with their precision', () => {
    expect(read('Date')).toEqual({ kind: 'date' });
    expect(read('Date32')).toEqual({ kind: 'date' });
    expect(read('DateTime')).toEqual({ kind: 'datetime', zone: false, precision: 0 });
    expect(read("DateTime('UTC')")).toEqual({ kind: 'datetime', zone: false, precision: 0 });
    expect(read("DateTime64(3, 'UTC')")).toEqual({ kind: 'datetime', zone: false, precision: 3 });
    expect(read('DateTime64(9)')).toEqual({ kind: 'datetime', zone: false, precision: 6 });
    expect(read('Time')).toEqual({ kind: 'time' });
  });

  it('reads UUIDs, enums with their values, and composites as JSON', () => {
    expect(read('UUID')).toEqual({ kind: 'uuid' });
    expect(read("Enum8('New' = 1, 'paid' = 2)")).toEqual({ kind: 'enum', values: ['New', 'paid'] });
    expect(read("Nullable(Enum16('a' = 1))")).toEqual({ kind: 'enum', values: ['a'] });
    for (const type of [
      'Array(Int32)',
      'Map(String, Int32)',
      'Tuple(String, Int32)',
      'JSON',
      'Nested(a Int32)',
    ]) {
      expect(read(type), type).toEqual({ kind: 'json' });
    }
    expect(read('IPv4')).toEqual({ kind: 'text' });
  });
});

describe('ClickHouse as the target (V6.3)', () => {
  const write = (neutral: Parameters<typeof targetType>[0]) =>
    targetType(neutral, 'clickhouse', false);

  it('writes integers with their sign and width', () => {
    expect(write({ kind: 'boolean' })).toEqual({ type: 'Bool', length: '' });
    expect(write({ kind: 'integer', bytes: 1, unsigned: true })).toEqual({
      type: 'UInt8',
      length: '',
    });
    expect(write({ kind: 'integer', bytes: 3, unsigned: false })).toEqual({
      type: 'Int32',
      length: '',
    });
    expect(write({ kind: 'integer', bytes: 8, unsigned: false })).toEqual({
      type: 'Int64',
      length: '',
    });
  });

  it('writes decimals within 76 digits and floats by width', () => {
    expect(write({ kind: 'decimal' })).toEqual({ type: 'Decimal', length: '38,10' });
    expect(write({ kind: 'decimal', precision: 100, scale: 4 })).toEqual({
      type: 'Decimal',
      length: '76,4',
    });
    expect(write({ kind: 'float', double: true })).toEqual({ type: 'Float64', length: '' });
    expect(write({ kind: 'float', double: false })).toEqual({ type: 'Float32', length: '' });
  });

  it('writes every kind of text as String, enums as LowCardinality(String)', () => {
    for (const neutral of [
      { kind: 'string', length: 5, fixed: true },
      { kind: 'text' },
      { kind: 'json' },
      { kind: 'binary' },
      { kind: 'time' },
    ] as const) {
      expect(write(neutral), neutral.kind).toEqual({ type: 'String', length: '' });
    }
    expect(write({ kind: 'enum', values: ['a'] })).toEqual({
      type: 'LowCardinality',
      length: 'String',
    });
  });

  it('writes dates as Date32 and moments as DateTime64, in UTC when they had a zone', () => {
    expect(write({ kind: 'date' })).toEqual({ type: 'Date32', length: '' });
    expect(write({ kind: 'datetime', zone: false })).toEqual({ type: 'DateTime64', length: '6' });
    expect(write({ kind: 'datetime', zone: true, precision: 3 })).toEqual({
      type: 'DateTime64',
      length: "3, 'UTC'",
    });
    expect(write({ kind: 'uuid' })).toEqual({ type: 'UUID', length: '' });
  });

  it('keeps ClickHouse types as they are between ClickHouse servers', () => {
    expect(mapColumnType("DateTime64(3, 'UTC')", 'clickhouse', 'clickhouse', false)).toEqual({
      type: 'DateTime64',
      length: "3, 'UTC'",
    });
    expect(mapColumnType('tinyint(1)', 'mysql', 'clickhouse', false)).toEqual({
      type: 'Bool',
      length: '',
    });
  });
});

describe('defaults to and from ClickHouse (V6.3)', () => {
  it('writes booleans as true and false', () => {
    expect(mapDefault('TRUE', { kind: 'boolean' }, 'postgres', 'clickhouse')).toBe('true');
    expect(mapDefault('0', { kind: 'boolean' }, 'mysql', 'clickhouse')).toBe('false');
  });

  it('turns the current time into now() or now64(p), the current date into today()', () => {
    expect(
      mapDefault(
        'CURRENT_TIMESTAMP(3)',
        { kind: 'datetime', zone: false, precision: 3 },
        'mysql',
        'clickhouse',
      ),
    ).toBe('now64(3)');
    expect(
      mapDefault(
        'now()',
        { kind: 'datetime', zone: false, precision: 0 },
        'postgres',
        'clickhouse',
      ),
    ).toBe('now()');
    expect(mapDefault('CURRENT_DATE', { kind: 'date' }, 'postgres', 'clickhouse')).toBe('today()');
    expect(mapDefault("'x'", { kind: 'text' }, 'postgres', 'clickhouse')).toBe("'x'");
  });

  it("carries ClickHouse's today() and now64() to the others", () => {
    expect(mapDefault('today()', { kind: 'date' }, 'clickhouse', 'postgres')).toBe('CURRENT_DATE');
    expect(mapDefault('today()', { kind: 'date' }, 'clickhouse', 'mssql')).toBe(
      'CAST(GETDATE() AS date)',
    );
    expect(
      mapDefault(
        'now64(3)',
        { kind: 'datetime', zone: false, precision: 3 },
        'clickhouse',
        'mysql',
      ),
    ).toBe('CURRENT_TIMESTAMP(3)');
    expect(
      mapDefault('generateUUIDv4()', { kind: 'uuid' }, 'clickhouse', 'postgres'),
    ).toBeUndefined();
  });
});

describe('Oracle as the source (V6.4)', () => {
  const read = (type: string) => neutralType(type, 'oracle');

  it('reads NUMBER without a precision as a decimal of any size', () => {
    expect(read('NUMBER')).toEqual({ kind: 'decimal' });
    expect(read('number')).toEqual({ kind: 'decimal' });
  });

  it('reads NUMBER(p) as the narrowest integer that holds p digits', () => {
    expect(read('NUMBER(1)')).toEqual({ kind: 'integer', bytes: 2, unsigned: false });
    expect(read('number(4)')).toEqual({ kind: 'integer', bytes: 2, unsigned: false });
    expect(read('NUMBER(5)')).toEqual({ kind: 'integer', bytes: 4, unsigned: false });
    expect(read('NUMBER(9)')).toEqual({ kind: 'integer', bytes: 4, unsigned: false });
    expect(read('NUMBER(10)')).toEqual({ kind: 'integer', bytes: 8, unsigned: false });
    expect(read('NUMBER( 18 )')).toEqual({ kind: 'integer', bytes: 8, unsigned: false });
    expect(read('NUMBER(10,0)')).toEqual({ kind: 'integer', bytes: 8, unsigned: false });
  });

  it('keeps NUMBER(p) beyond 18 digits exact as a decimal', () => {
    expect(read('NUMBER(19)')).toEqual({ kind: 'decimal', precision: 19, scale: 0 });
    expect(read('NUMBER(38)')).toEqual({ kind: 'decimal', precision: 38, scale: 0 });
  });

  it('reads NUMBER(p,s) as a decimal, a negative scale as none', () => {
    expect(read('NUMBER(10,2)')).toEqual({ kind: 'decimal', precision: 10, scale: 2 });
    expect(read('NUMBER(10, -2)')).toEqual({ kind: 'decimal', precision: 10, scale: 0 });
  });

  it('reads INTEGER, INT and SMALLINT as the 38-digit numbers Oracle makes of them', () => {
    for (const type of ['INTEGER', 'INT', 'SMALLINT']) {
      expect(read(type), type).toEqual({ kind: 'decimal', precision: 38, scale: 0 });
    }
  });

  it('reads binary floats by width and FLOAT as a double', () => {
    expect(read('BINARY_FLOAT')).toEqual({ kind: 'float', double: false });
    expect(read('BINARY_DOUBLE')).toEqual({ kind: 'float', double: true });
    expect(read('FLOAT')).toEqual({ kind: 'float', double: true });
    expect(read('FLOAT(126)')).toEqual({ kind: 'float', double: true });
  });

  it('reads DATE as a moment to the second: it carries a time of day', () => {
    expect(read('DATE')).toEqual({ kind: 'datetime', zone: false, precision: 0 });
  });

  it('reads TIMESTAMP with its precision, at most 6, and its zone', () => {
    expect(read('TIMESTAMP')).toEqual({ kind: 'datetime', zone: false, precision: 6 });
    expect(read('TIMESTAMP(3)')).toEqual({ kind: 'datetime', zone: false, precision: 3 });
    expect(read('TIMESTAMP(0)')).toEqual({ kind: 'datetime', zone: false, precision: 0 });
    expect(read('TIMESTAMP(9)')).toEqual({ kind: 'datetime', zone: false, precision: 6 });
    expect(read('TIMESTAMP(6) WITH TIME ZONE')).toEqual({
      kind: 'datetime',
      zone: true,
      precision: 6,
    });
    expect(read('TIMESTAMP(3) WITH LOCAL TIME ZONE')).toEqual({
      kind: 'datetime',
      zone: true,
      precision: 3,
    });
    expect(read('TIMESTAMP WITH TIME ZONE')).toMatchObject({ zone: true });
  });

  it('reads intervals, row ids and LONG as text', () => {
    for (const type of [
      'INTERVAL DAY(2) TO SECOND(6)',
      'INTERVAL YEAR(2) TO MONTH',
      'ROWID',
      'UROWID',
      'LONG',
    ]) {
      expect(read(type), type).toEqual({ kind: 'text' });
    }
  });

  it('reads national strings, LOBs and RAW like the other databases do', () => {
    expect(read('NVARCHAR2(50)')).toEqual({ kind: 'string', length: 50, fixed: false });
    expect(read('NCHAR(5)')).toEqual({ kind: 'string', length: 5, fixed: true });
    expect(read('CLOB')).toEqual({ kind: 'text' });
    expect(read('NCLOB')).toEqual({ kind: 'text' });
    expect(read('BLOB')).toEqual({ kind: 'binary' });
    expect(read('RAW(16)')).toEqual({ kind: 'binary' });
    expect(read('JSON')).toEqual({ kind: 'json' });
  });

  it('reads NUMBER the usual way for the other databases', () => {
    expect(neutralType('number(10)', 'postgres')).toEqual({
      kind: 'decimal',
      precision: 10,
      scale: 0,
    });
    expect(neutralType('date', 'postgres')).toEqual({ kind: 'date' });
  });
});

describe('Oracle as the target (V6.4)', () => {
  const write = (neutral: Parameters<typeof targetType>[0], indexed = false) =>
    targetType(neutral, 'oracle', indexed);

  it('writes booleans as NUMBER(1), which every version has', () => {
    expect(write({ kind: 'boolean' })).toEqual({ type: 'NUMBER', length: '1' });
  });

  it('writes integers as NUMBER with room for every value of their width', () => {
    expect(write({ kind: 'integer', bytes: 1, unsigned: false })).toEqual({
      type: 'NUMBER',
      length: '5',
    });
    expect(write({ kind: 'integer', bytes: 2, unsigned: true })).toEqual({
      type: 'NUMBER',
      length: '5',
    });
    expect(write({ kind: 'integer', bytes: 3, unsigned: false })).toEqual({
      type: 'NUMBER',
      length: '10',
    });
    expect(write({ kind: 'integer', bytes: 4, unsigned: true })).toEqual({
      type: 'NUMBER',
      length: '10',
    });
    expect(write({ kind: 'integer', bytes: 8, unsigned: false })).toEqual({
      type: 'NUMBER',
      length: '19',
    });
    expect(write({ kind: 'integer', bytes: 8, unsigned: true })).toEqual({
      type: 'NUMBER',
      length: '20',
    });
  });

  it('writes decimals as NUMBER(p,s), and as plain NUMBER beyond 38 digits', () => {
    expect(write({ kind: 'decimal', precision: 10, scale: 2 })).toEqual({
      type: 'NUMBER',
      length: '10,2',
    });
    expect(write({ kind: 'decimal', precision: 12 })).toEqual({ type: 'NUMBER', length: '12,0' });
    expect(write({ kind: 'decimal', precision: 5, scale: 9 })).toEqual({
      type: 'NUMBER',
      length: '5,5',
    });
    expect(write({ kind: 'decimal' })).toEqual({ type: 'NUMBER', length: '' });
    expect(write({ kind: 'decimal', precision: 39, scale: 2 })).toEqual({
      type: 'NUMBER',
      length: '',
    });
  });

  it('writes floats as BINARY_FLOAT and BINARY_DOUBLE', () => {
    expect(write({ kind: 'float', double: false })).toEqual({ type: 'BINARY_FLOAT', length: '' });
    expect(write({ kind: 'float', double: true })).toEqual({ type: 'BINARY_DOUBLE', length: '' });
  });

  it('writes strings in characters: CHAR up to 2000, VARCHAR2 up to 4000, CLOB beyond', () => {
    expect(write({ kind: 'string', length: 10, fixed: true })).toEqual({
      type: 'CHAR',
      length: '10 CHAR',
    });
    expect(write({ kind: 'string', length: 2000, fixed: true })).toEqual({
      type: 'CHAR',
      length: '2000 CHAR',
    });
    expect(write({ kind: 'string', length: 2001, fixed: true })).toEqual({
      type: 'VARCHAR2',
      length: '2001 CHAR',
    });
    expect(write({ kind: 'string', length: 4000, fixed: false })).toEqual({
      type: 'VARCHAR2',
      length: '4000 CHAR',
    });
    expect(write({ kind: 'string', length: 4001, fixed: false })).toEqual({
      type: 'CLOB',
      length: '',
    });
  });

  it('writes long text, JSON and binary as LOBs, or short enough to index when indexed', () => {
    expect(write({ kind: 'text' })).toEqual({ type: 'CLOB', length: '' });
    expect(write({ kind: 'json' })).toEqual({ type: 'CLOB', length: '' });
    expect(write({ kind: 'binary' })).toEqual({ type: 'BLOB', length: '' });
    expect(write({ kind: 'text' }, true)).toEqual({ type: 'VARCHAR2', length: '1000 CHAR' });
    expect(write({ kind: 'json' }, true)).toEqual({ type: 'VARCHAR2', length: '1000 CHAR' });
    expect(write({ kind: 'string', length: 4001, fixed: false }, true)).toEqual({
      type: 'VARCHAR2',
      length: '1000 CHAR',
    });
    expect(write({ kind: 'binary' }, true)).toEqual({ type: 'RAW', length: '2000' });
    // Short strings fit an index as they are.
    expect(write({ kind: 'string', length: 50, fixed: false }, true)).toEqual({
      type: 'VARCHAR2',
      length: '50 CHAR',
    });
  });

  it('writes enums as VARCHAR2 as long as the longest value, 255 without values', () => {
    expect(write({ kind: 'enum', values: ['a', 'bbb'] })).toEqual({
      type: 'VARCHAR2',
      length: '3 CHAR',
    });
    expect(write({ kind: 'enum', values: [''] })).toEqual({ type: 'VARCHAR2', length: '1 CHAR' });
    expect(write({ kind: 'enum', values: [] })).toEqual({ type: 'VARCHAR2', length: '255 CHAR' });
  });

  it('writes dates, times, moments and UUIDs', () => {
    expect(write({ kind: 'date' })).toEqual({ type: 'DATE', length: '' });
    expect(write({ kind: 'time' })).toEqual({ type: 'VARCHAR2', length: '16 CHAR' });
    expect(write({ kind: 'datetime', zone: false })).toEqual({ type: 'TIMESTAMP', length: '6' });
    expect(write({ kind: 'datetime', zone: false, precision: 0 })).toEqual({
      type: 'TIMESTAMP',
      length: '0',
    });
    expect(write({ kind: 'datetime', zone: true, precision: 3 })).toEqual({
      type: 'TIMESTAMP WITH TIME ZONE',
      length: '3',
    });
    expect(write({ kind: 'uuid' })).toEqual({ type: 'VARCHAR2', length: '36 CHAR' });
  });

  it('maps column types between Oracle and the others', () => {
    expect(mapColumnType('VARCHAR2(100 CHAR)', 'oracle', 'oracle', false)).toEqual({
      type: 'VARCHAR2',
      length: '100 CHAR',
    });
    expect(mapColumnType('NUMBER(10)', 'oracle', 'postgres', false)).toEqual({
      type: 'bigint',
      length: '',
    });
    expect(mapColumnType('varchar(50)', 'postgres', 'oracle', false)).toEqual({
      type: 'VARCHAR2',
      length: '50 CHAR',
    });
    expect(mapColumnType('bool', 'postgres', 'oracle', false)).toEqual({
      type: 'NUMBER',
      length: '1',
    });
  });
});

describe('defaults to and from Oracle (V6.4)', () => {
  it('writes booleans as 1 and 0', () => {
    expect(mapDefault('TRUE', { kind: 'boolean' }, 'postgres', 'oracle')).toBe('1');
    expect(mapDefault("'f'", { kind: 'boolean' }, 'postgres', 'oracle')).toBe('0');
    expect(mapDefault("b'1'", { kind: 'boolean' }, 'mysql', 'oracle')).toBe('1');
    expect(mapDefault('maybe', { kind: 'boolean' }, 'postgres', 'oracle')).toBeUndefined();
  });

  it('turns the current date into TRUNC(SYSDATE)', () => {
    expect(mapDefault('CURRENT_DATE', { kind: 'date' }, 'postgres', 'oracle')).toBe(
      'TRUNC(SYSDATE)',
    );
    expect(mapDefault('today()', { kind: 'date' }, 'clickhouse', 'oracle')).toBe('TRUNC(SYSDATE)');
  });

  it('turns the current time into SYSDATE to the second, SYSTIMESTAMP otherwise', () => {
    expect(
      mapDefault('now()', { kind: 'datetime', zone: false, precision: 0 }, 'postgres', 'oracle'),
    ).toBe('SYSDATE');
    expect(mapDefault('now()', { kind: 'datetime', zone: false }, 'postgres', 'oracle')).toBe(
      'SYSTIMESTAMP',
    );
    expect(
      mapDefault(
        'CURRENT_TIMESTAMP(3)',
        { kind: 'datetime', zone: true, precision: 3 },
        'mysql',
        'oracle',
      ),
    ).toBe('SYSTIMESTAMP');
    expect(
      mapDefault('GETDATE()', { kind: 'datetime', zone: false, precision: 3 }, 'mssql', 'oracle'),
    ).toBe('SYSTIMESTAMP');
  });

  it('carries literals over and drops what it cannot translate', () => {
    expect(
      mapDefault('42', { kind: 'integer', bytes: 4, unsigned: false }, 'mysql', 'oracle'),
    ).toBe('42');
    expect(mapDefault("'new'::character varying", { kind: 'text' }, 'postgres', 'oracle')).toBe(
      "'new'",
    );
    expect(mapDefault('NULL', { kind: 'text' }, 'postgres', 'oracle')).toBeUndefined();
    expect(mapDefault('gen_random_uuid()', { kind: 'uuid' }, 'postgres', 'oracle')).toBeUndefined();
  });

  it("reads Oracle's SYSDATE and SYSTIMESTAMP as the current time for the others", () => {
    const seconds = { kind: 'datetime', zone: false, precision: 0 } as const;
    expect(mapDefault('SYSDATE', seconds, 'oracle', 'postgres')).toBe('CURRENT_TIMESTAMP');
    expect(mapDefault('sysdate ', seconds, 'oracle', 'clickhouse')).toBe('now()');
    expect(
      mapDefault('SYSTIMESTAMP', { kind: 'datetime', zone: true, precision: 6 }, 'oracle', 'mssql'),
    ).toBe('SYSDATETIMEOFFSET()');
    expect(
      mapDefault(
        'SYSTIMESTAMP(3)',
        { kind: 'datetime', zone: false, precision: 3 },
        'oracle',
        'mysql',
      ),
    ).toBe('CURRENT_TIMESTAMP(3)');
    expect(mapDefault('SYS_GUID()', { kind: 'text' }, 'oracle', 'postgres')).toBeUndefined();
  });

  it('keeps every default as it is between Oracle servers', () => {
    expect(mapDefault('SYS_GUID()', { kind: 'text' }, 'oracle', 'oracle')).toBe('SYS_GUID()');
  });
});

describe('Oracle lengths and odd types (V6.4)', () => {
  it('reads the length of CHAR and BYTE lengths', () => {
    expect(neutralType('VARCHAR2(100 CHAR)', 'oracle')).toEqual({
      kind: 'string',
      length: 100,
      fixed: false,
    });
    expect(neutralType('VARCHAR2(40 BYTE)', 'oracle')).toEqual({
      kind: 'string',
      length: 40,
      fixed: false,
    });
    expect(neutralType('CHAR(10 CHAR)', 'oracle')).toEqual({
      kind: 'string',
      length: 10,
      fixed: true,
    });
    expect(neutralType('NCHAR(3)', 'oracle')).toEqual({ kind: 'string', length: 3, fixed: true });
  });

  it('reads LONG RAW as binary', () => {
    expect(neutralType('LONG RAW', 'oracle')).toEqual({ kind: 'binary' });
  });

  it('carries TRUNC(SYSDATE) over as the current date', () => {
    const date = neutralType('date', 'postgres');
    expect(mapDefault('TRUNC(SYSDATE)', date, 'oracle', 'postgres')).toBe('CURRENT_DATE');
    expect(mapDefault('trunc( sysdate )', date, 'oracle', 'mssql')).toBe('CAST(GETDATE() AS date)');
  });

  it('drops a clock default for a time of day, which Oracle keeps as text', () => {
    const time = neutralType('time', 'postgres');
    expect(mapDefault('CURRENT_TIME', time, 'postgres', 'oracle')).toBeUndefined();
    expect(mapDefault('CURRENT_TIMESTAMP', time, 'postgres', 'oracle')).toBeUndefined();
  });
});
