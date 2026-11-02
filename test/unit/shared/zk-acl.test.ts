import { describe, expect, it } from 'vitest';
import { aclLocksOut, aclProblem, isDigestHash } from '../../../src/shared/zk-acl';

describe('aclProblem', () => {
  it.each([
    [{ perms: 31, scheme: 'world', id: 'anyone' }, undefined],
    [{ perms: 1, scheme: 'auth', id: '' }, undefined],
    [{ perms: 17, scheme: 'digest', id: 'alice:abc' }, undefined],
    [{ perms: 3, scheme: 'ip', id: '10.0.0.0/8' }, undefined],
    [{ perms: 3, scheme: 'x509', id: 'CN=bob' }, undefined],
    [{ perms: 3, scheme: 'sasl', id: 'bob' }, undefined],
    [{ perms: 31, scheme: 'kerberos', id: 'x' }, 'scheme'],
    [{ perms: 0, scheme: 'world', id: 'anyone' }, 'perms'],
    [{ perms: 32, scheme: 'world', id: 'anyone' }, 'perms'],
    [{ perms: 1.5, scheme: 'world', id: 'anyone' }, 'perms'],
    [{ perms: 1, scheme: 'world', id: 'someone' }, 'world-id'],
    [{ perms: 1, scheme: 'auth', id: 'alice' }, 'auth-id'],
    [{ perms: 1, scheme: 'digest', id: 'alice' }, 'digest-id'],
    [{ perms: 1, scheme: 'digest', id: ':pw' }, 'digest-id'],
    [{ perms: 1, scheme: 'digest', id: 'alice:' }, 'digest-id'],
    [{ perms: 1, scheme: 'ip', id: '  ' }, 'id-empty'],
  ])('%j → %s', (entry, expected) => {
    expect(aclProblem(entry)).toBe(expected);
  });
});

describe('aclLocksOut', () => {
  it('is true when no entry may administer the znode', () => {
    expect(aclLocksOut([{ perms: 15, scheme: 'world', id: 'anyone' }])).toBe(true);
    expect(aclLocksOut([])).toBe(true);
  });

  it('is false once one entry has the admin bit', () => {
    expect(
      aclLocksOut([
        { perms: 1, scheme: 'world', id: 'anyone' },
        { perms: 16, scheme: 'auth', id: '' },
      ]),
    ).toBe(false);
  });
});

describe('isDigestHash', () => {
  it('knows a base64 SHA-1 from a password', () => {
    expect(isDigestHash('pwUIFuU3fyDXJ8CWOnVpZPLfAog=')).toBe(true);
    expect(isDigestHash('secret')).toBe(false);
    expect(isDigestHash('pwUIFuU3fyDXJ8CWOnVpZPLfAog')).toBe(false);
  });
});
