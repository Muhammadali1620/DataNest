import { describe, expect, it } from 'vitest';
import { convertValue } from '../../../src/services/import/import-values';
import type { DriverId } from '../../../src/shared/connection';
import { pick, pieces, seeded } from '../../helpers/fuzz';

const TYPES = [
  'int',
  'bigint',
  'smallint',
  'tinyint(1)',
  'numeric(10,2)',
  'decimal',
  'float',
  'double precision',
  'real',
  'text',
  'varchar(20)',
  'boolean',
  'date',
  'datetime',
  'timestamp',
  'time',
  'json',
  'jsonb',
  'bytea',
  'blob',
  'uuid',
  "enum('a','b')",
  'interval',
  'geometry',
  '',
];

const PARTS = [
  '0',
  '-0',
  '1',
  '-1',
  '007',
  '1.5',
  '.5',
  '5.',
  '1e5',
  '1E-5',
  '1e999',
  '9007199254740993',
  '99999999999999999999',
  'NaN',
  'Infinity',
  '-Infinity',
  'true',
  'FALSE',
  't',
  'yes',
  '2024-02-29',
  '2023-02-29',
  '2024-13-01',
  '24:00:00',
  '12:34:56.789',
  '2024-12-31 23:59:59',
  '2024-12-31T23:59:59Z',
  '0x',
  '0xDEADBEEF',
  '\\x00ff',
  '{"a":1}',
  '[1,2',
  "'",
  '"',
  ' ',
  '\t',
  'é',
  '\u{1F600}',
  '\u0000',
  ',',
  '.',
  '-',
  '+',
  'e',
  'a',
];

const DRIVERS: (DriverId | undefined)[] = [undefined, 'mysql', 'postgres', 'sqlite', 'mssql'];

describe('values of a file converted for a column', () => {
  it('never throw, and a number that is accepted is a finite number or an exact text', () => {
    const random = seeded(5150);
    for (let round = 0; round < 12000; round += 1) {
      const text = pieces(random, PARTS, 4);
      const type = pick(random, TYPES);
      const driver = pick(random, DRIVERS);
      const options = { emptyIsNull: random() < 0.5, nullText: pick(random, ['', 'NULL', '\\N']) };
      const label = JSON.stringify({ text, type, driver, options });
      const result = convertValue(text, type, options, driver);
      expect(typeof result.ok, label).toBe('boolean');
      if (result.ok && typeof result.value === 'number') {
        expect(Number.isFinite(result.value), label).toBe(true);
        if (Number.isInteger(result.value)) {
          // An integer never silently loses digits: past 2^53 it must stay exact text.
          expect(Number.isSafeInteger(result.value), label).toBe(true);
        }
      }
    }
  });
});
