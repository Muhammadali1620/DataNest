// How etcd nodes look in the tree (V13.19): the label, icon, description, menu context
// and the command a click runs.

import { describe, expect, it, vi } from 'vitest';
import { etcdFolderItem, etcdKeyItem, etcdMoreItem } from '../../../../src/vscode/tree/etcd-items';
import { nodeId, TREE_CONTEXT } from '../../../../src/vscode/tree/nodes';
import * as stub from '../../../helpers/vscode-stub';

vi.mock('vscode', () => import('../../../helpers/vscode-stub'));

const icon = (value: unknown): stub.ThemeIcon => value as stub.ThemeIcon;

describe('etcdFolderItem', () => {
  const node = {
    kind: 'etcdFolder',
    connectionId: 'c1',
    prefix: { text: '/app/' },
    name: 'app',
    count: 1234,
  } as const;

  it('is a collapsed blue folder with the number of keys below it', () => {
    const item = etcdFolderItem(node);
    expect(item.label).toBe('app');
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.Collapsed);
    expect(item.id).toBe(nodeId(node));
    expect(item.contextValue).toBe(TREE_CONTEXT.etcdFolder);
    expect(icon(item.iconPath).id).toBe('folder');
    expect(icon(item.iconPath).color?.id).toBe('charts.blue');
    expect(item.description).toBe('1,234');
    expect(item.tooltip).toBe('/app/\n1,234 keys below');
  });

  it('shows no number before the cluster was asked', () => {
    const { count: _count, ...bare } = node;
    const item = etcdFolderItem(bare);
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBe('/app/');
  });

  it('calls the folder of names that start with a slash by that slash', () => {
    expect(etcdFolderItem({ ...node, prefix: { text: '/' }, name: '' }).label).toBe('/');
  });
});

describe('etcdKeyItem', () => {
  const node = {
    kind: 'etcdKey',
    connectionId: 'c1',
    key: { text: '/app/db' },
    name: 'db',
  } as const;

  it('is a leaf with a yellow key that opens its page on a click', () => {
    const item = etcdKeyItem(node);
    expect(item.label).toBe('db');
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.None);
    expect(item.id).toBe(nodeId(node));
    expect(item.contextValue).toBe(TREE_CONTEXT.etcdKey);
    expect(icon(item.iconPath).id).toBe('key');
    expect(icon(item.iconPath).color?.id).toBe('charts.yellow');
    expect(item.tooltip).toBe('/app/db');
    expect(item.command).toEqual({
      command: 'datanest.etcd.openKey',
      title: 'Open Key',
      arguments: [node],
    });
  });

  it('draws a key that dies with a lease as an orange clock and says so', () => {
    const item = etcdKeyItem({ ...node, leased: true });
    expect(icon(item.iconPath).id).toBe('watch');
    expect(icon(item.iconPath).color?.id).toBe('charts.orange');
    expect(item.tooltip).toBe('/app/db\nEnds with its lease');
  });
});

describe('etcdMoreItem', () => {
  const node = {
    kind: 'etcdMore',
    connectionId: 'c1',
    prefix: { text: '/a/' },
    loaded: 12_345,
  } as const;

  it('is a leaf that loads the next page on a click', () => {
    const item = etcdMoreItem(node);
    expect(item.label).toBe('Load more keys…');
    expect(item.collapsibleState).toBe(stub.TreeItemCollapsibleState.None);
    expect(item.description).toBe('12,345 loaded');
    expect(item.contextValue).toBe(TREE_CONTEXT.etcdMore);
    expect(icon(item.iconPath).id).toBe('ellipsis');
    expect(item.command).toEqual({
      command: 'datanest.etcd.loadMoreKeys',
      title: 'Load more keys',
      arguments: [node],
    });
  });
});
