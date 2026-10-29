import { describe, expect, it } from 'vitest';
import { KeyTree, type LoadedKey } from '../../../../src/services/redis/key-tree';

const key = (text: string, type = 'string'): LoadedKey => ({ key: { text }, type });

function tree(...names: string[]): KeyTree {
  const built = new KeyTree(':');
  built.add(names.map((name) => key(name)));
  return built;
}

describe('KeyTree', () => {
  it('groups keys into folders by the separator, counting every key below', () => {
    const keys = tree('user:1:name', 'user:1:mail', 'user:2:name', 'app:name', 'solo');
    const top = keys.children([]);
    expect(top.folders).toEqual([
      { name: 'app', path: ['app'], count: 1 },
      { name: 'user', path: ['user'], count: 3 },
    ]);
    expect(top.keys.map((leaf) => leaf.name)).toEqual(['solo']);
    expect(keys.children(['user']).folders.map((folder) => folder.count)).toEqual([2, 1]);
    expect(keys.children(['user', '1']).keys.map((leaf) => leaf.entry.key.text)).toEqual([
      'user:1:mail',
      'user:1:name',
    ]);
    expect(keys.size).toBe(5);
  });

  it('sorts numbers as numbers', () => {
    const keys = tree('n:10', 'n:2', 'n:1');
    expect(keys.children(['n']).keys.map((leaf) => leaf.name)).toEqual(['1', '2', '10']);
  });

  it('keeps a key and a folder of the same name apart', () => {
    const keys = tree('user', 'user:1');
    expect(keys.children([]).folders.map((folder) => folder.name)).toEqual(['user']);
    expect(keys.children([]).keys.map((leaf) => leaf.name)).toEqual(['user']);
  });

  it('keeps empty segments as folders of their own', () => {
    const keys = tree('a::b', 'a:');
    expect(keys.children(['a']).folders).toEqual([{ name: '', path: ['a', ''], count: 1 }]);
    expect(keys.children(['a']).keys.map((leaf) => leaf.name)).toEqual(['']);
  });

  it('counts a key added twice once, with the newer type', () => {
    const keys = new KeyTree(':');
    keys.add([key('a:1', 'string'), key('a:1', 'hash')]);
    expect(keys.size).toBe(1);
    expect(keys.children([]).folders[0]?.count).toBe(1);
    expect(keys.children(['a']).keys[0]?.entry.type).toBe('hash');
    expect(keys.has({ text: 'a:1' })).toBe(true);
  });

  it('keeps every key at the top without a separator', () => {
    const keys = new KeyTree('');
    keys.add([key('a:1'), key('a:2')]);
    expect(keys.children([]).folders).toEqual([]);
    expect(keys.children([]).keys.map((leaf) => leaf.name)).toEqual(['a:1', 'a:2']);
    expect(keys.folderOf({ text: 'a:1' })).toEqual([]);
  });

  it('works with a separator of several characters', () => {
    const keys = new KeyTree('::');
    keys.add([key('a::b::c')]);
    expect(keys.folderOf({ text: 'a::b::c' })).toEqual(['a', 'b']);
  });

  it('tells binary keys apart by their bytes', () => {
    const keys = new KeyTree(':');
    keys.add([{ key: { text: 'b:\\xff', hex: '623aff' } }, key('b:\\xff')]);
    expect(keys.children(['b']).keys).toHaveLength(2);
  });

  it('removes a key with the folders it leaves empty, and ignores an unknown one', () => {
    const keys = tree('a:b:c', 'a:d');
    keys.remove({ text: 'a:b:c' });
    expect(keys.children(['a']).folders).toEqual([]);
    expect(keys.children([]).folders).toEqual([{ name: 'a', path: ['a'], count: 1 }]);
    keys.remove({ text: 'nope' });
    keys.remove({ text: 'a:d' });
    expect(keys.children([])).toEqual({ folders: [], keys: [] });
    expect(keys.size).toBe(0);
  });

  it('lists nothing inside a folder that does not exist', () => {
    expect(tree('a:1').children(['b', 'c'])).toEqual({ folders: [], keys: [] });
  });

  it('lists every entry in the order added', () => {
    expect(
      tree('b', 'a')
        .entries()
        .map((entry) => entry.key.text),
    ).toEqual(['b', 'a']);
  });
});
