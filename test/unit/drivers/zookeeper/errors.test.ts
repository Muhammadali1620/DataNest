import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  networkFailure,
  ZK,
  zookeeperFailure,
  zookeeperKind,
  zookeeperText,
} from '../../../../src/drivers/zookeeper/errors';

describe('zookeeperKind', () => {
  it.each([
    [ZK.NO_NODE, 'not-found'],
    [ZK.NO_AUTH, 'permission-denied'],
    [ZK.INVALID_ACL, 'permission-denied'],
    [ZK.NOT_READ_ONLY, 'permission-denied'],
    [ZK.QUOTA_EXCEEDED, 'permission-denied'],
    [ZK.AUTH_FAILED, 'auth-failed'],
    [ZK.BAD_VERSION, 'constraint'],
    [ZK.NODE_EXISTS, 'constraint'],
    [ZK.NOT_EMPTY, 'constraint'],
    [ZK.NO_CHILDREN_FOR_EPHEMERALS, 'constraint'],
    [ZK.BAD_ARGUMENTS, 'syntax'],
    [ZK.OPERATION_TIMEOUT, 'timeout'],
    [ZK.CONNECTION_LOSS, 'connection-failed'],
    [ZK.SESSION_EXPIRED, 'connection-failed'],
    [ZK.SESSION_MOVED, 'connection-failed'],
    [ZK.CLOSING, 'connection-failed'],
    [ZK.SYSTEM_ERROR, 'internal'],
    [-999, 'internal'],
  ] as const)('maps code %i to %s', (code, kind) => {
    expect(zookeeperKind(code)).toBe(kind);
  });
});

describe('zookeeperText', () => {
  it('names the path in the messages that are about one', () => {
    for (const code of [
      ZK.NO_NODE,
      ZK.NO_AUTH,
      ZK.BAD_VERSION,
      ZK.NODE_EXISTS,
      ZK.NOT_EMPTY,
      ZK.NO_CHILDREN_FOR_EPHEMERALS,
      ZK.INVALID_ACL,
      ZK.BAD_ARGUMENTS,
      ZK.QUOTA_EXCEEDED,
    ]) {
      expect(zookeeperText(code, '/app/x')).toContain('/app/x');
    }
  });

  it('says something for the codes about the session and the server', () => {
    for (const code of [ZK.SESSION_EXPIRED, ZK.AUTH_FAILED, ZK.NOT_READ_ONLY, ZK.CONNECTION_LOSS]) {
      expect(zookeeperText(code, '/')).not.toBe('');
    }
  });

  it('gives an unknown code with its number', () => {
    expect(zookeeperText(-77, '/x')).toContain('-77');
    expect(zookeeperText(-77, '/x')).toContain('/x');
  });
});

describe('zookeeperFailure', () => {
  it('is a DbError of the right kind that keeps the code', () => {
    const error = zookeeperFailure(ZK.BAD_VERSION, '/a');
    expect(error).toBeInstanceOf(DbError);
    expect(error.code).toBe('constraint');
    expect(error.driverCode).toBe(ZK.BAD_VERSION);
  });
});

describe('networkFailure', () => {
  it('is the same as for the other network drivers', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:2181'), {
      code: 'ECONNREFUSED',
    });
    expect(networkFailure(refused).code).toBe('connection-failed');
  });
});
