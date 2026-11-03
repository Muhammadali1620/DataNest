import { describe, expect, it } from 'vitest';
import { isReadOnlyStatement } from '../../../src/core/sql/read-only';
import { splitStatements } from '../../../src/core/sql/split';
import { syntaxOf, tokenize } from '../../../src/core/sql/tokenizer';
import { findVariables, substituteVariables } from '../../../src/core/sql/variables';
import type { DriverId } from '../../../src/shared/connection';
import { pieces, seeded } from '../../helpers/fuzz';

const DRIVERS: DriverId[] = [
  'mysql',
  'postgres',
  'sqlite',
  'mssql',
  'clickhouse',
  'oracle',
  'libsql',
];

// Pieces that make a scanner's life hard: quotes of every kind, comments, delimiters,
// dollar quotes, placeholders, escapes, newlines, non-ASCII text and lone surrogates.
const ALPHABET = [
  "'",
  '"',
  '`',
  '[',
  ']',
  '(',
  ')',
  ';',
  ',',
  '.',
  '-',
  '--',
  '/*',
  '*/',
  '#',
  '$$',
  '$a$',
  '$',
  ':',
  '?',
  '?1',
  ':name',
  '${x}',
  '\\',
  "''",
  'E',
  "E'",
  "q'[",
  "]'",
  'N',
  "N'",
  'U&"',
  '\n',
  '\r\n',
  ' ',
  '\t',
  'SELECT',
  'select',
  '1',
  '0x1F',
  '1e5',
  'a',
  'é',
  '日本',
  '\u{1F600}',
  '\uD800',
  '\u0000',
  'DELIMITER ',
  '//',
  'GO',
  '\nGO\n',
  'BEGIN',
  'END',
  'CREATE PROCEDURE p AS ',
  '\\connect ',
  'REM ',
  'SET DEFINE OFF',
  'WITH',
  'INSERT',
  'DROP',
  'UPDATE',
  'DELETE',
  'EXPLAIN',
  'VALUES',
];

function inputs(seed: number, count: number): string[] {
  const random = seeded(seed);
  return Array.from({ length: count }, () => pieces(random, ALPHABET, 40));
}

describe('the SQL scanner on random text', () => {
  for (const driver of DRIVERS) {
    const base = DRIVERS.indexOf(driver) * 10;

    it(`${driver}: tokens tile the source without gaps, overlaps or empty tokens`, () => {
      for (const [index, sql] of inputs(1000 + base, 1500).entries()) {
        const label = `${driver} #${index} ${JSON.stringify(sql)}`;
        const tokens = tokenize(sql, syntaxOf(driver));
        let at = 0;
        for (const token of tokens) {
          expect(token.start, label).toBe(at);
          expect(token.end, label).toBeGreaterThan(token.start);
          at = token.end;
        }
        expect(at, label).toBe(sql.length);
      }
    });

    it(`${driver}: statements are exact, ordered slices of the script`, () => {
      for (const [index, sql] of inputs(2000 + base, 1500).entries()) {
        const label = `${driver} #${index} ${JSON.stringify(sql)}`;
        let previous = 0;
        for (const statement of splitStatements(sql, driver)) {
          expect(statement.start, label).toBeGreaterThanOrEqual(previous);
          expect(statement.end, label).toBeGreaterThan(statement.start);
          expect(sql.slice(statement.start, statement.end), label).toBe(statement.text);
          expect(statement.text, label).toBe(statement.text.trim());
          previous = statement.end;
        }
      }
    });

    it(`${driver}: variables lie inside the text and substitution keeps the rest`, () => {
      for (const [index, sql] of inputs(4000 + base, 1500).entries()) {
        const label = `${driver} #${index} ${JSON.stringify(sql)}`;
        const variables = findVariables(sql, driver);
        let previousEnd = 0;
        for (const variable of variables) {
          expect(variable.start, label).toBeGreaterThanOrEqual(previousEnd);
          expect(variable.end, label).toBeGreaterThan(variable.start);
          expect(variable.end, label).toBeLessThanOrEqual(sql.length);
          previousEnd = variable.end;
        }
        const result = substituteVariables(sql, variables, () => '');
        const removed = variables.reduce(
          (sum, variable) => sum + (variable.end - variable.start),
          0,
        );
        expect(result.text.length, label).toBe(sql.length - removed);
        for (let position = 0; position <= result.text.length; position += 1) {
          const mapped = result.toSource(position);
          expect(mapped, label).toBeGreaterThanOrEqual(0);
          expect(mapped, label).toBeLessThanOrEqual(sql.length);
        }
      }
    });

    it(`${driver}: the read-only check never throws`, () => {
      for (const sql of inputs(5000 + base, 2000)) {
        expect(typeof isReadOnlyStatement(sql, syntaxOf(driver))).toBe('boolean');
      }
    });
  }
});
