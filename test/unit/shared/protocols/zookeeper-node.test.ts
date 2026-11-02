import { describe, expect, it } from 'vitest';
import {
  CREATE_MODES,
  ZNODE_KINDS,
  zookeeperNodeProtocol,
  zookeeperNodeStateSchema,
  znodeAclSchema,
} from '../../../../src/shared/protocols/zookeeper-node';

const state = {
  path: '/app',
  connectionName: 'c',
  readOnly: false,
  exists: true,
  value: { text: 'v' },
  size: 1,
  kind: 'persistent',
  version: 2,
  cversion: 1,
  aversion: 0,
  czxid: '4',
  mzxid: '5',
  pzxid: '6',
  ephemeralOwner: '0',
  ctime: 1_700_000_000_000,
  mtime: 1_700_000_100_000,
  numChildren: 2,
  acl: [{ perms: 31, scheme: 'world', id: 'anyone' }],
  children: ['a', 'b'],
  moreChildren: false,
};

describe('the ZooKeeper znode page state', () => {
  it('accepts a znode with and without data, denied or in conflict', () => {
    expect(zookeeperNodeStateSchema.parse(state)).toMatchObject({ exists: true });
    expect(zookeeperNodeStateSchema.parse({ ...state, conflict: true })).toMatchObject({
      conflict: true,
    });
    expect(
      zookeeperNodeStateSchema.parse({ ...state, value: undefined, denied: true }),
    ).toMatchObject({ denied: true });
    expect(
      zookeeperNodeStateSchema.parse({ ...state, exists: false, value: undefined }),
    ).toBeDefined();
  });

  it('knows the kinds of znode', () => {
    for (const kind of ZNODE_KINDS) {
      expect(zookeeperNodeStateSchema.parse({ ...state, kind })).toBeDefined();
    }
    expect(() => zookeeperNodeStateSchema.parse({ ...state, kind: 'other' })).toThrow();
  });

  it('refuses a state that is not whole', () => {
    expect(() => zookeeperNodeStateSchema.parse({ ...state, czxid: 5 })).toThrow();
    expect(() => zookeeperNodeStateSchema.parse({ ...state, size: -1 })).toThrow();
    expect(() => zookeeperNodeStateSchema.parse({ ...state, version: 1.5 })).toThrow();
    expect(() => zookeeperNodeStateSchema.parse({ ...state, children: [1] })).toThrow();
    expect(() => zookeeperNodeStateSchema.parse({ ...state, acl: undefined })).toThrow();
  });

  it('keeps ids as text of at most 24 characters', () => {
    expect(() => zookeeperNodeStateSchema.parse({ ...state, mzxid: '1'.repeat(25) })).toThrow();
    expect(
      zookeeperNodeStateSchema.parse({ ...state, ephemeralOwner: '9'.repeat(24) }),
    ).toBeDefined();
  });
});

describe('an ACL entry', () => {
  it('has permissions of five bits, a scheme and an id', () => {
    expect(znodeAclSchema.parse({ perms: 31, scheme: 'digest', id: 'u:h' })).toBeDefined();
    expect(znodeAclSchema.parse({ perms: 0, scheme: 'auth', id: '' })).toBeDefined();
    expect(() => znodeAclSchema.parse({ perms: 32, scheme: 'x', id: '' })).toThrow();
    expect(() => znodeAclSchema.parse({ perms: -1, scheme: 'x', id: '' })).toThrow();
    expect(() => znodeAclSchema.parse({ perms: 1.5, scheme: 'x', id: '' })).toThrow();
  });
});

describe('the ZooKeeper znode page requests', () => {
  const { requests } = zookeeperNodeProtocol.host;

  it('takes a save with the version the page read and, on purpose, overwrite', () => {
    expect(requests.save.params.parse({ value: { text: 'x' }, version: 5 })).toBeDefined();
    expect(
      requests.save.params.parse({ value: { text: 'x' }, version: 0, overwrite: true }),
    ).toMatchObject({ overwrite: true });
    expect(() => requests.save.params.parse({ value: { text: 'x' } })).toThrow();
    expect(() => requests.save.params.parse({ version: 5 })).toThrow();
    expect(() => requests.save.params.parse({ value: { text: 'x' }, version: -1 })).toThrow();
  });

  it('takes a child by name and the way it lives', () => {
    for (const mode of CREATE_MODES) {
      expect(requests.createChild.params.parse({ name: 'c', mode })).toBeDefined();
    }
    expect(() => requests.createChild.params.parse({ name: 'c', mode: 'ephemeral' })).toThrow();
    expect(() => requests.createChild.params.parse({ mode: 'persistent' })).toThrow();
  });

  it('opens a child by name, deletes and copies', () => {
    expect(requests.openChild.params.parse({ name: 'c' })).toBeDefined();
    expect(requests.deleteNode.params.parse({})).toBeDefined();
    expect(requests.copyText.params.parse({ text: '/a' })).toBeDefined();
    expect(() => requests.copyText.params.parse({})).toThrow();
  });
});
