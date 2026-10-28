import { describe, expect, it } from 'vitest';
import { planDrop } from '../../../../src/vscode/tree/drop-plan';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';

const conn = (connectionId: string): TreeNode => ({ kind: 'connection', connectionId });
const folder = (name: string): TreeNode => ({ kind: 'connectionFolder', folder: name });
const folders: Record<string, string | undefined> = { a: 'Prod', b: 'Prod', c: undefined };
const folderOf = (id: string) => folders[id];

describe('planDrop', () => {
  it('moves connections into the folder they are dropped on', () => {
    expect(planDrop([conn('c')], folder('Dev'), folderOf)).toEqual({
      kind: 'connections',
      ids: ['c'],
      destination: { folder: 'Dev' },
    });
  });

  it('moves connections in front of the connection they are dropped on, in its folder', () => {
    expect(planDrop([conn('c'), conn('x')], conn('b'), folderOf)).toEqual({
      kind: 'connections',
      ids: ['c', 'x'],
      destination: { folder: 'Prod', before: 'b' },
    });
    expect(planDrop([conn('a')], conn('c'), folderOf)).toEqual({
      kind: 'connections',
      ids: ['a'],
      destination: { before: 'c' },
    });
  });

  it('moves connections to the end of the top level when dropped on empty space', () => {
    expect(planDrop([conn('a')], undefined, folderOf)).toEqual({
      kind: 'connections',
      ids: ['a'],
      destination: {},
    });
  });

  it('treats anything inside a connection as that connection', () => {
    const table: TreeNode = {
      kind: 'table',
      connectionId: 'b',
      scope: {},
      name: 't',
      tableKind: 'table',
    };
    expect(planDrop([conn('c')], table, folderOf)).toMatchObject({
      destination: { folder: 'Prod', before: 'b' },
    });
  });

  it('drops onto the "empty folder" leaf into that folder', () => {
    expect(
      planDrop([conn('c')], { kind: 'message', text: 'Empty', folder: 'Dev' }, folderOf),
    ).toMatchObject({ destination: { folder: 'Dev' } });
    expect(planDrop([conn('c')], { kind: 'message', text: 'Error' }, folderOf)).toBeUndefined();
  });

  it('does nothing when dropped on itself or when nothing movable is dragged', () => {
    expect(planDrop([conn('a')], conn('a'), folderOf)).toBeUndefined();
    expect(planDrop([], folder('Dev'), folderOf)).toBeUndefined();
    expect(
      planDrop([{ kind: 'database', connectionId: 'a', database: 'd' }], undefined, folderOf),
    ).toBeUndefined();
  });

  it('moves a folder in front of another folder, or of the folder of a connection', () => {
    expect(planDrop([folder('Dev')], folder('Prod'), folderOf)).toEqual({
      kind: 'folder',
      folder: 'Dev',
      before: 'Prod',
    });
    expect(planDrop([folder('Dev')], conn('a'), folderOf)).toEqual({
      kind: 'folder',
      folder: 'Dev',
      before: 'Prod',
    });
    expect(
      planDrop([folder('Dev')], { kind: 'message', text: 'Empty', folder: 'Prod' }, folderOf),
    ).toEqual({ kind: 'folder', folder: 'Dev', before: 'Prod' });
  });

  it('moves a folder last when dropped on empty space or a loose connection', () => {
    expect(planDrop([folder('Dev')], undefined, folderOf)).toEqual({
      kind: 'folder',
      folder: 'Dev',
    });
    expect(planDrop([folder('Dev')], conn('c'), folderOf)).toEqual({
      kind: 'folder',
      folder: 'Dev',
    });
  });

  it('leaves a folder dropped on itself or its own connection alone', () => {
    expect(planDrop([folder('Prod')], folder('Prod'), folderOf)).toBeUndefined();
    expect(planDrop([folder('Prod')], conn('a'), folderOf)).toBeUndefined();
  });

  it('leaves project connections where the file keeps them (V4.7)', () => {
    const inProject = (id: string) => id.startsWith('p-');
    const project: TreeNode = { kind: 'project', key: 'file:///shop', name: 'shop' };
    // Dragging one does nothing; with others, only the others move.
    expect(planDrop([conn('p-1')], folder('Dev'), folderOf, inProject)).toBeUndefined();
    expect(planDrop([conn('p-1'), conn('c')], folder('Dev'), folderOf, inProject)).toEqual({
      kind: 'connections',
      ids: ['c'],
      destination: { folder: 'Dev' },
    });
    // Nothing lands on a project or among its connections.
    expect(planDrop([conn('c')], project, folderOf, inProject)).toBeUndefined();
    expect(planDrop([conn('c')], conn('p-1'), folderOf, inProject)).toBeUndefined();
    expect(planDrop([folder('Prod')], conn('p-1'), folderOf, inProject)).toBeUndefined();
    expect(
      planDrop(
        [conn('c')],
        { kind: 'database', connectionId: 'p-1', database: 'app' },
        folderOf,
        inProject,
      ),
    ).toBeUndefined();
  });
});
