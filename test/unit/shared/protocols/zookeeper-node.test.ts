import { describe, expect, it } from 'vitest';
import {
  CREATE_MODES,
  WATCH_KINDS,
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

describe('the ZooKeeper znode page: the ACL below', () => {
  it('takes the request to give the ACL to everything below, too', () => {
    const { requests } = zookeeperNodeProtocol.host;
    const acl = [{ perms: 1, scheme: 'world', id: 'anyone' }];
    expect(requests.saveAcl.params.parse({ acl, aversion: 0, recursive: true })).toMatchObject({
      recursive: true,
    });
    expect(requests.saveAcl.params.parse({ acl, aversion: 0 })).toBeDefined();
    expect(() => requests.saveAcl.params.parse({ acl, aversion: 0, recursive: 'yes' })).toThrow();
  });

  it('takes a report of what was done below', () => {
    const report = { changed: 3, failed: 1, failures: ['/a: no'], capped: false };
    expect(zookeeperNodeStateSchema.parse({ ...state, aclTree: report })).toMatchObject({
      aclTree: report,
    });
    for (const bad of [
      { ...report, changed: -1 },
      { ...report, failures: Array.from({ length: 11 }, () => 'x') },
      { ...report, capped: undefined },
    ]) {
      expect(() => zookeeperNodeStateSchema.parse({ ...state, aclTree: bad })).toThrow();
    }
  });
});

describe('the ZooKeeper znode page: watching', () => {
  const event = { at: 1_700_000_000_000, kind: 'data', version: 3, size: 5, children: 2 };

  it('takes a state that is watching, with the changes it saw and a notice', () => {
    expect(
      zookeeperNodeStateSchema.parse({
        ...state,
        watching: true,
        events: WATCH_KINDS.map((kind) => ({ ...event, kind })),
        watchNotice: 'Watching stopped: the session ended',
      }),
    ).toMatchObject({ watching: true });
  });

  it('refuses a change that is not whole, of another kind, or too many of them', () => {
    for (const bad of [
      { ...event, kind: 'acl' },
      { ...event, version: -1 },
      { ...event, children: 1.5 },
      { ...event, at: '1' },
      { ...event, size: undefined },
    ]) {
      expect(() => zookeeperNodeStateSchema.parse({ ...state, events: [bad] })).toThrow();
    }
    expect(() =>
      zookeeperNodeStateSchema.parse({
        ...state,
        events: Array.from({ length: 201 }, () => event),
      }),
    ).toThrow();
  });

  it('takes the request to watch and to clear', () => {
    const { requests } = zookeeperNodeProtocol.host;
    expect(requests.watch.params.parse({ on: true })).toEqual({ on: true });
    expect(() => requests.watch.params.parse({})).toThrow();
    expect(requests.clearEvents.params.parse({})).toBeDefined();
  });
});
