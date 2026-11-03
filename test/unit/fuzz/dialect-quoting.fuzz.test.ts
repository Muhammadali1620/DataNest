import { describe, expect, it } from 'vitest';
import { unquoteIdentifier } from '../../../src/core/sql/identifiers';
import { syntaxOf, tokenize } from '../../../src/core/sql/tokenizer';
import { clickhouseDialect } from '../../../src/drivers/clickhouse/dialect';
import type { Dialect } from '../../../src/drivers/driver';
import { mssqlDialect } from '../../../src/drivers/mssql/dialect';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { oracleDialect } from '../../../src/drivers/oracle/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import type { DriverId } from '../../../src/shared/connection';
import { pieces, seeded } from '../../helpers/fuzz';

const DIALECTS: [DriverId, Dialect][] = [
  ['mysql', mysqlDialect],
  ['postgres', postgresDialect],
  ['sqlite', sqliteDialect],
  ['mssql', mssqlDialect],
  ['clickhouse', clickhouseDialect],
  ['oracle', oracleDialect],
];

// What a hostile or just unlucky value looks like: the characters a quoting routine
// has to get right, so that a value can never leave the string it is written in.
const PARTS = [
  "'",
  "''",
  '"',
  '""',
  '`',
  '``',
  '\\',
  '\\\\',
  "\\'",
  ';',
  '--',
  '/*',
  '*/',
  '$$',
  '$a$',
  '[',
  ']',
  ']]',
  '\n',
  '\r',
  '\t',
  ' ',
  'DROP TABLE t',
  "'; DROP TABLE t; --",
  'a',
  'é',
  '日本',
  '\u{1F600}',
  '\u0000',
  ' ',
  '%',
  '_',
  '?',
  ':x',
];

function values(seed: number, count: number): string[] {
  const random = seeded(seed);
  return Array.from({ length: count }, () => pieces(random, PARTS, 12));
}

describe('dialect quoting on hostile text', () => {
  for (const [driver, dialect] of DIALECTS) {
    const base = DIALECTS.findIndex(([id]) => id === driver) * 7;

    it(`${driver}: a text literal is one string token and nothing else`, () => {
      for (const [index, value] of values(100 + base, 3000).entries()) {
        const sql = dialect.literal(value);
        const tokens = tokenize(sql, syntaxOf(driver)).filter(
          (token) => token.kind !== 'whitespace',
        );
        const label = `${driver} #${index} ${JSON.stringify(value)} -> ${JSON.stringify(sql)}`;
        // A prefix word (`N'…'`, `E'…'`, `X'…'`) may stand before the string.
        const strings = tokens.filter((token) => token.kind === 'string');
        expect(strings.length, label).toBe(1);
        expect(
          tokens.every((token) => token.kind === 'string' || token.kind === 'word'),
          label,
        ).toBe(true);
        expect(strings[0]?.unterminated, label).toBeUndefined();
        expect(strings[0]?.end, label).toBe(sql.length);
      }
    });

    it(`${driver}: a quoted identifier is one token and reads back as the name`, () => {
      for (const [index, value] of values(200 + base, 3000).entries()) {
        // Oracle has no escape for a double quote: it refuses such a name. (The reading
        // back of ClickHouse names with a backslash is left out: `unquoteIdentifier`
        // knows no dialect, but the scanner must still see one token.)
        if (
          value === '' ||
          value.includes('\u0000') ||
          (driver === 'oracle' && value.includes('"'))
        ) {
          continue;
        }
        const sql = dialect.quoteIdentifier(value);
        const tokens = tokenize(sql, syntaxOf(driver));
        const label = `${driver} #${index} ${JSON.stringify(value)} -> ${JSON.stringify(sql)}`;
        expect(tokens.length, label).toBe(1);
        expect(tokens[0]?.kind, label).toBe('quoted-identifier');
        expect(tokens[0]?.unterminated, label).toBeUndefined();
        if (driver !== 'clickhouse') {
          expect(unquoteIdentifier(sql), label).toBe(value);
        }
      }
    });
  }

  it('numbers become text that is one number token, never a name or an operator', () => {
    const numbers = [0, -0, 1, -1, 1.5, 1e21, 1e-7, 123456789012345680000, Number.MAX_VALUE];
    for (const [driver, dialect] of DIALECTS) {
      for (const value of numbers) {
        const sql = dialect.literal(value);
        const tokens = tokenize(sql, syntaxOf(driver)).filter(
          (token) => token.kind !== 'whitespace',
        );
        expect(
          tokens.every(
            (token) =>
              token.kind === 'number' || token.kind === 'punctuation' || token.kind === 'word',
          ),
          `${driver} ${value} -> ${sql}`,
        ).toBe(true);
        expect(sql, `${driver} ${value}`).not.toMatch(/[;']/u);
      }
    }
  });

  it('NaN and Infinity never reach the server as bare words', () => {
    // ClickHouse spells them `nan` and `inf`, which it does read as numbers.
    for (const [driver, dialect] of DIALECTS.filter(([id]) => id !== 'clickhouse')) {
      for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        let sql: string | undefined;
        try {
          sql = dialect.literal(value);
        } catch {
          sql = undefined;
        }
        if (sql !== undefined) {
          expect(sql, `${driver} ${value}`).not.toMatch(/^-?(nan|inf(inity)?)$/iu);
        }
      }
    }
  });
});
