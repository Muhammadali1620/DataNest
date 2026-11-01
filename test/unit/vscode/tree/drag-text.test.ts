import { describe, expect, it } from 'vitest';
import { clickhouseDialect } from '../../../../src/drivers/clickhouse/dialect';
import { mssqlDialect } from '../../../../src/drivers/mssql/dialect';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import type { Dialect } from '../../../../src/drivers/driver';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import {
  dragConnectionOf,
  dragTextOf,
  dragTextOfAll,
  hasDragText,
} from '../../../../src/vscode/tree/drag-text';

const table = (name: string, scope = {}): TreeNode => ({
  kind: 'table',
  connectionId: 'c',
  scope,
  name,
  tableKind: 'table',
});
const column = (name: string): TreeNode => ({
  kind: 'column',
  connectionId: 'c',
  table: { name: 't' },
  column: { name, dataType: 'int', nullable: true, primaryKey: false },
});

describe('dragTextOf', () => {
  it('quotes a table the way each database does', () => {
    const node = table('order items', { database: 'shop' });
    expect(dragTextOf(node, mysqlDialect)).toBe('`shop`.`order items`');
    expect(dragTextOf(table('order items', { schema: 'public' }), postgresDialect)).toBe(
      '"public"."order items"',
    );
    expect(dragTextOf(table('order items'), sqliteDialect)).toBe('"order items"');
    expect(dragTextOf(table('t', { database: 'd', schema: 'dbo' }), mssqlDialect)).toBe(
      '[dbo].[t]',
    );
  });

  it('escapes the quote characters of a name instead of trusting it', () => {
    expect(dragTextOf(table('a`b'), mysqlDialect)).toBe('`a``b`');
    expect(dragTextOf(table('a"b; DROP TABLE x'), postgresDialect)).toBe('"a""b; DROP TABLE x"');
    expect(dragTextOf(column('x]y'), mssqlDialect)).toBe('[x]]y]');
  });

  it('gives a column, a database and a schema as one quoted part', () => {
    expect(dragTextOf(column('user id'), postgresDialect)).toBe('"user id"');
    expect(
      dragTextOf({ kind: 'database', connectionId: 'c', database: 'shop' }, clickhouseDialect),
    ).toBe(clickhouseDialect.quoteIdentifier('shop'));
    expect(
      dragTextOf(
        { kind: 'schema', connectionId: 'c', database: 'd', schema: 'sales' },
        mssqlDialect,
      ),
    ).toBe('[sales]');
  });

  it('gives a view, a routine and a sequence their qualified name', () => {
    const view: TreeNode = { ...table('v', { schema: 's' }), tableKind: 'view' } as TreeNode;
    expect(dragTextOf(view, postgresDialect)).toBe('"s"."v"');
    expect(
      dragTextOf(
        {
          kind: 'object',
          connectionId: 'c',
          object: { kind: 'function', name: 'f', schema: 's' },
        },
        postgresDialect,
      ),
    ).toBe('"s"."f"');
  });

  it('has no text for nodes that are not names', () => {
    const nodes: TreeNode[] = [
      { kind: 'connection', connectionId: 'c' },
      { kind: 'connectionFolder', folder: 'Work' },
      { kind: 'redisDatabase', connectionId: 'c', database: 0, keys: 1 },
    ];
    for (const node of nodes) {
      expect(hasDragText(node)).toBe(false);
      expect(dragConnectionOf(node)).toBeUndefined();
      expect(dragTextOf(node, mysqlDialect)).toBeUndefined();
    }
  });
});

describe('dragTextOfAll', () => {
  const dialects: Record<string, Dialect> = { m: mysqlDialect, p: postgresDialect };
  const on = (connectionId: string, node: TreeNode): TreeNode =>
    ({ ...node, connectionId }) as TreeNode;

  it('writes one line per node, in the order dragged, each in its own dialect', () => {
    const text = dragTextOfAll(
      [on('m', table('a')), on('p', table('b')), on('m', column('c'))],
      (id) => dialects[id],
    );
    expect(text).toBe('`a`\n"b"\n`c`');
  });

  it('skips nodes that are not names and connections without a dialect', () => {
    expect(
      dragTextOfAll(
        [{ kind: 'connection', connectionId: 'm' }, on('gone', table('a')), on('m', table('z'))],
        (id) => dialects[id],
      ),
    ).toBe('`z`');
  });

  it('is empty for nothing', () => {
    expect(dragTextOfAll([], () => mysqlDialect)).toBe('');
  });
});
