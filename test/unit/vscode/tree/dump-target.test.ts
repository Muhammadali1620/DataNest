import { describe, expect, it } from 'vitest';
import { dumpFileName, dumpStartOf } from '../../../../src/vscode/tree/dump-target';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';

const table = (name: string, schema = 'public', connectionId = 'c'): TreeNode => ({
  kind: 'table',
  connectionId,
  scope: { database: 'shop', schema },
  name,
  tableKind: 'table',
});

describe('dumpStartOf', () => {
  it('starts with the clicked table when nothing else is selected', () => {
    expect(dumpStartOf(table('orders'), undefined)).toEqual({
      connectionId: 'c',
      scope: { database: 'shop', schema: 'public' },
      preselect: ['orders'],
      wholeScope: false,
    });
  });

  it('takes the selected tables of the same connection and scope', () => {
    const start = dumpStartOf(table('a'), [
      table('a'),
      table('b'),
      table('other', 'sales'),
      table('x', 'public', 'c2'),
      { kind: 'database', connectionId: 'c', database: 'shop' },
    ]);
    expect(start?.preselect).toEqual(['a', 'b']);
  });

  it('ignores a selection the clicked table is not part of', () => {
    expect(dumpStartOf(table('a'), [table('b')])?.preselect).toEqual(['a']);
  });

  it('offers everything of a database or schema, the rest included', () => {
    expect(
      dumpStartOf({ kind: 'database', connectionId: 'c', database: 'shop' }, undefined),
    ).toEqual({
      connectionId: 'c',
      scope: { database: 'shop' },
      preselect: undefined,
      wholeScope: true,
    });
    expect(
      dumpStartOf({ kind: 'schema', connectionId: 'c', database: 'shop', schema: 's' }, undefined)
        ?.scope,
    ).toEqual({ database: 'shop', schema: 's' });
  });

  it('ticks only the tables or the views of a folder', () => {
    const folder = (group: 'tables' | 'views' | 'functions'): TreeNode => ({
      kind: 'group',
      group,
      connectionId: 'c',
      scope: { database: 'shop' },
    });
    expect(dumpStartOf(folder('tables'), undefined)).toMatchObject({
      only: 'table',
      wholeScope: false,
    });
    expect(dumpStartOf(folder('views'), undefined)).toMatchObject({ only: 'view' });
    expect(dumpStartOf(folder('functions'), undefined)).toBeUndefined();
  });

  it('leaves the scope open for a connection', () => {
    expect(dumpStartOf({ kind: 'connection', connectionId: 'c' }, undefined)).toEqual({
      connectionId: 'c',
      scope: undefined,
      preselect: undefined,
      wholeScope: true,
    });
  });

  it('has nothing to dump for other items', () => {
    expect(dumpStartOf({ kind: 'connectionFolder', folder: 'f' }, undefined)).toBeUndefined();
    expect(dumpStartOf({ kind: 'message', text: 'x' }, undefined)).toBeUndefined();
  });
});

describe('dumpFileName', () => {
  const date = new Date(2026, 9, 29, 14, 5);

  it('names the file after what is dumped and when', () => {
    expect(dumpFileName('shop', date)).toBe('shop-2026-10-29-1405.sql');
  });

  it('replaces characters no file system accepts', () => {
    expect(dumpFileName('a/b:c*?"<>|', date)).toBe('a-b-c-2026-10-29-1405.sql');
    expect(dumpFileName('...', date)).toBe('dump-2026-10-29-1405.sql');
  });
});
