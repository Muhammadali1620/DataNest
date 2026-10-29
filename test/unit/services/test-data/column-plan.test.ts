import { describe, expect, it } from 'vitest';
import {
  normalizedName,
  type PlanColumn,
  suggestGenerator,
  typeSettings,
} from '../../../../src/services/test-data/column-plan';

function column(name: string, dataType: string, extra: Partial<PlanColumn> = {}): PlanColumn {
  return {
    name,
    dataType,
    nullable: true,
    autoIncrement: false,
    generated: false,
    unique: false,
    ...extra,
  };
}

describe('normalizedName', () => {
  it('turns any naming style into snake case', () => {
    expect(normalizedName('firstName')).toBe('first_name');
    expect(normalizedName('Created-At')).toBe('created_at');
    expect(normalizedName('postal code')).toBe('postal_code');
  });
});

describe('suggestGenerator', () => {
  it('leaves numbered and computed columns to the database', () => {
    expect(suggestGenerator(column('id', 'int', { autoIncrement: true, unique: true }))).toBe(
      'default',
    );
    expect(suggestGenerator(column('total', 'int', { generated: true }))).toBe('default');
  });

  it('points a foreign key at existing rows', () => {
    expect(
      suggestGenerator(
        column('customer_id', 'int', { reference: { table: 'customers', column: 'id' } }),
      ),
    ).toBe('reference');
  });

  it('counts a unique integer that the database does not number', () => {
    expect(suggestGenerator(column('id', 'integer', { unique: true }))).toBe('sequence');
  });

  it('reads the meaning of text columns from their names', () => {
    const cases: [string, string][] = [
      ['email', 'email'],
      ['user_email', 'email'],
      ['firstName', 'firstName'],
      ['surname', 'lastName'],
      ['full_name', 'fullName'],
      ['name', 'fullName'],
      ['username', 'username'],
      ['mobile_phone', 'phone'],
      ['company', 'company'],
      ['city', 'city'],
      ['country_code', 'countryCode'],
      ['country', 'country'],
      ['street_address', 'address'],
      ['zip', 'postalCode'],
      ['website', 'url'],
      ['ip_address', 'ip'],
      ['color', 'color'],
      ['currency', 'currency'],
      ['status', 'status'],
      ['title', 'words'],
      ['description', 'sentence'],
      ['anything_else', 'words'],
    ];
    for (const [name, kind] of cases) {
      expect(suggestGenerator(column(name, 'varchar(255)')), name).toBe(kind);
    }
  });

  it('reads numbers by name and type', () => {
    expect(suggestGenerator(column('price', 'decimal(10,2)'))).toBe('price');
    expect(suggestGenerator(column('total', 'int'))).toBe('price');
    expect(suggestGenerator(column('latitude', 'double precision'))).toBe('latitude');
    expect(suggestGenerator(column('lng', 'numeric(9,6)'))).toBe('longitude');
    expect(suggestGenerator(column('age', 'smallint'))).toBe('integer');
    expect(suggestGenerator(column('ratio', 'real'))).toBe('decimal');
  });

  it('falls back to the type', () => {
    expect(suggestGenerator(column('flag', 'boolean'))).toBe('boolean');
    expect(suggestGenerator(column('born', 'date'))).toBe('date');
    expect(suggestGenerator(column('at', 'timestamp with time zone'))).toBe('datetime');
    expect(suggestGenerator(column('starts', 'time'))).toBe('time');
    expect(suggestGenerator(column('size', "enum('s','m')"))).toBe('enum');
    expect(suggestGenerator(column('data', 'jsonb'))).toBe('json');
    expect(suggestGenerator(column('photo', 'bytea'))).toBe('binary');
    expect(suggestGenerator(column('token', 'uuid'))).toBe('uuid');
  });
});

describe('typeSettings', () => {
  it('reads text lengths, fixed or not', () => {
    expect(typeSettings(column('a', 'varchar(20)'), 'words')).toMatchObject({ maxLength: 20 });
    expect(typeSettings(column('a', 'varchar(20)'), 'words').fixedLength).toBeUndefined();
    expect(typeSettings(column('a', 'char(3)'), 'words')).toMatchObject({
      maxLength: 3,
      fixedLength: true,
    });
    expect(typeSettings(column('a', 'character varying(9)'), 'words')).toMatchObject({
      maxLength: 9,
    });
    expect(typeSettings(column('a', 'text'), 'words').maxLength).toBeUndefined();
  });

  it('reads the scale and the range of decimals', () => {
    expect(typeSettings(column('a', 'decimal(5,2)'), 'decimal')).toMatchObject({
      scale: 2,
      max: 999,
    });
    expect(typeSettings(column('a', 'numeric(30,10)'), 'decimal')).toMatchObject({
      scale: 10,
      max: 10_000,
    });
    expect(typeSettings(column('a', 'double'), 'decimal')).toMatchObject({ scale: 2 });
  });

  it('keeps integers within their type', () => {
    expect(typeSettings(column('a', 'tinyint(1)'), 'integer')).toMatchObject({ min: 0, max: 1 });
    expect(typeSettings(column('a', 'tinyint unsigned'), 'integer')).toMatchObject({ max: 255 });
    expect(typeSettings(column('a', 'smallint'), 'integer')).toMatchObject({ max: 32_000 });
    expect(typeSettings(column('a', 'year'), 'integer')).toMatchObject({ min: 1990 });
    expect(typeSettings(column('a', 'bigint'), 'integer')).toMatchObject({ min: 1, max: 100_000 });
  });

  it('lists the values of an enum and marks unique columns', () => {
    expect(typeSettings(column('a', "enum('x','y''z')"), 'enum').choices).toEqual(['x', "y'z"]);
    expect(typeSettings(column('a', 'text', { unique: true }), 'words').unique).toBe(true);
  });
});

describe('ClickHouse types (V6.3)', () => {
  it('keeps integers within the width the type name says', () => {
    expect(typeSettings(column('a', 'UInt8'), 'integer')).toMatchObject({ min: 0, max: 255 });
    expect(typeSettings(column('a', 'Int8'), 'integer')).toMatchObject({ min: 1, max: 127 });
    expect(typeSettings(column('a', 'UInt16'), 'integer')).toMatchObject({ min: 1, max: 32_000 });
    expect(typeSettings(column('a', 'Int64'), 'integer')).toMatchObject({ min: 1, max: 100_000 });
    expect(typeSettings(column('a', 'Nullable(UInt8)'), 'integer')).toMatchObject({
      min: 0,
      max: 255,
    });
  });

  it('reads decimals, strings and enums through their wrappers', () => {
    expect(typeSettings(column('a', 'Nullable(Decimal(5, 2))'), 'decimal')).toMatchObject({
      scale: 2,
      max: 999,
    });
    expect(typeSettings(column('a', "Enum8('s' = 1, 'm' = 2)"), 'enum').choices).toEqual([
      's',
      'm',
    ]);
  });

  it('suggests generators by the ClickHouse type', () => {
    expect(suggestGenerator(column('level', 'UInt8'))).toBe('integer');
    expect(suggestGenerator(column('flag', 'Bool'))).toBe('boolean');
    expect(suggestGenerator(column('born', 'Date32'))).toBe('date');
    expect(suggestGenerator(column('seen', "DateTime64(3, 'UTC')"))).toBe('datetime');
    expect(suggestGenerator(column('token', 'UUID'))).toBe('uuid');
    expect(suggestGenerator(column('size', "Enum8('s' = 1)"))).toBe('enum');
  });
});

describe('Oracle columns (V6.4)', () => {
  it("fills Oracle's DATE with moments, since it holds a time of day", () => {
    expect(suggestGenerator(column('born', 'DATE', { driver: 'oracle' }))).not.toBe(
      suggestGenerator(column('born', 'DATE')),
    );
    expect(suggestGenerator(column('born', 'DATE'))).toBe('date');
  });

  it('reads lengths that say CHAR or BYTE, and NUMBER(p,s) ranges', () => {
    expect(typeSettings(column('a', 'VARCHAR2(60 CHAR)'), 'words')).toMatchObject({
      maxLength: 60,
    });
    expect(typeSettings(column('a', 'CHAR(4 BYTE)'), 'words')).toMatchObject({
      maxLength: 4,
      fixedLength: true,
    });
    expect(typeSettings(column('a', 'NVARCHAR2(20)'), 'words')).toMatchObject({ maxLength: 20 });
    expect(typeSettings(column('a', 'NUMBER(5,2)'), 'decimal')).toMatchObject({
      scale: 2,
      max: 999,
    });
  });
});
