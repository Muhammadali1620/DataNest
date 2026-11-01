import { describe, expect, it } from 'vitest';
import {
  answerTable,
  chooseConnection,
  explainPrompt,
  extractSql,
  isRunnableByChat,
  queryPrompt,
} from '../../../src/services/ai-chat';
import type { ConnectionConfig } from '../../../src/shared/connection';

const shop: ConnectionConfig = { id: 'a', name: 'shop', driver: 'mysql' };
const staging: ConnectionConfig = { id: 'b', name: 'shop-staging', driver: 'postgres' };
const redis: ConnectionConfig = { id: 'c', name: 'cache', driver: 'redis' };
const off: ConnectionConfig = { id: 'd', name: 'old', driver: 'sqlite', disabled: true };

describe('chooseConnection', () => {
  it('has none when nothing is usable', () => {
    expect(chooseConnection('hi', [])).toEqual({ kind: 'none' });
    expect(chooseConnection('hi', [redis, off])).toEqual({ kind: 'none' });
  });

  it('takes the only usable connection', () => {
    expect(chooseConnection('how many users?', [shop, redis, off])).toEqual({
      kind: 'found',
      config: shop,
    });
  });

  it('takes the one the question names, in any case', () => {
    expect(chooseConnection('orders in SHOP last week', [shop, staging])).toEqual({
      kind: 'found',
      config: shop,
    });
  });

  it('prefers the longest name, so "shop" does not hide "shop-staging"', () => {
    expect(chooseConnection('count rows in shop-staging', [shop, staging])).toEqual({
      kind: 'found',
      config: staging,
    });
  });

  it('asks which one when several fit and none is named', () => {
    expect(chooseConnection('count rows', [shop, staging])).toEqual({
      kind: 'choose',
      configs: [shop, staging],
    });
  });

  it('never picks a switched-off or non-SQL connection, even by name', () => {
    expect(chooseConnection('look in old and cache', [shop, staging, off, redis])).toEqual({
      kind: 'choose',
      configs: [shop, staging],
    });
  });
});

describe('extractSql', () => {
  it('takes the first fenced block', () => {
    expect(extractSql('Here:\n```sql\nSELECT 1;\n```\nand\n```sql\nSELECT 2\n```')).toBe(
      'SELECT 1;',
    );
  });

  it('takes a block with another or no language word', () => {
    expect(extractSql('```\nSELECT 3\n```')).toBe('SELECT 3');
    expect(extractSql('```postgresql\nSELECT 4\n```')).toBe('SELECT 4');
  });

  it('takes the whole text when there is no block', () => {
    expect(extractSql('  SELECT 5  ')).toBe('SELECT 5');
  });
});

describe('isRunnableByChat', () => {
  it('runs one reading statement only', () => {
    expect(isRunnableByChat('SELECT 1', 'mysql')).toBe(true);
    expect(isRunnableByChat('SELECT 1;', 'postgres')).toBe(true);
    expect(isRunnableByChat('DELETE FROM t', 'mysql')).toBe(false);
    expect(isRunnableByChat('SELECT 1; SELECT 2', 'mysql')).toBe(false);
    expect(isRunnableByChat('', 'mysql')).toBe(false);
  });
});

describe('prompts', () => {
  it('carry the question, the dialect and the schema', () => {
    const prompt = queryPrompt({
      question: 'top customers',
      driver: 'postgres',
      digest: 'orders(id int pk)',
    });
    expect(prompt).toContain('postgres');
    expect(prompt).toContain('orders(id int pk)');
    expect(prompt).toContain('Question: top customers');
    expect(prompt).toContain('only reads');
  });

  it('say so when the schema is unknown', () => {
    expect(queryPrompt({ question: 'q', driver: 'mysql', digest: '' })).toContain('unknown');
  });

  it('put the statement in a block for the explanation, with the schema when there is one', () => {
    const withSchema = explainPrompt({ sql: 'SELECT 1', digest: 't(id int)' });
    expect(withSchema).toContain('```sql\nSELECT 1\n```');
    expect(withSchema).toContain('Schema:\nt(id int)');
    expect(explainPrompt({ sql: 'SELECT 1', digest: '' })).not.toContain('Schema:');
  });
});

describe('answerTable', () => {
  it('draws the rows of a tool answer as a Markdown table', () => {
    const text = JSON.stringify({
      columns: ['a', 'b'],
      rows: [
        [1, null],
        ['x|y', 'l1\nl2'],
      ],
      rowCount: 2,
    });
    expect(answerTable(text)).toBe(
      ['| a | b |', '| --- | --- |', '| 1 | NULL |', '| x\\|y | l1 l2 |'].join('\n'),
    );
  });

  it('notes that more rows exist', () => {
    const text = JSON.stringify({ columns: ['a'], rows: [[1]], truncated: true });
    expect(answerTable(text)).toContain('more rows');
  });

  it('gives nothing for a text that is not a result', () => {
    expect(answerTable('Refused: …')).toBeUndefined();
    expect(answerTable('42')).toBeUndefined();
    expect(answerTable('null')).toBeUndefined();
    expect(answerTable(JSON.stringify({ columns: [], rows: [] }))).toBeUndefined();
    expect(answerTable(JSON.stringify({ rows: [] }))).toBeUndefined();
  });
});
