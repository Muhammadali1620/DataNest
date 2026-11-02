// ZooKeeper answers a failed request with a negative code in the reply header. The code says
// what went wrong; the server sends no text. Network failures carry Node's codes and are
// the same as for any socket driver.

import { DbError, type DbErrorCode } from '../../core/errors';
import { msg } from '../../core/user-message';
import { networkFailure } from '../elasticsearch/errors';

export { networkFailure };

/** The codes of `KeeperException.Code` a browser can meet. */
export const ZK = {
  OK: 0,
  SYSTEM_ERROR: -1,
  CONNECTION_LOSS: -4,
  OPERATION_TIMEOUT: -7,
  BAD_ARGUMENTS: -8,
  NO_NODE: -101,
  NO_AUTH: -102,
  BAD_VERSION: -103,
  NO_CHILDREN_FOR_EPHEMERALS: -108,
  NODE_EXISTS: -110,
  NOT_EMPTY: -111,
  SESSION_EXPIRED: -112,
  INVALID_ACL: -114,
  AUTH_FAILED: -115,
  CLOSING: -116,
  SESSION_MOVED: -118,
  NOT_READ_ONLY: -119,
  QUOTA_EXCEEDED: -125,
} as const;

/** The kind of error a code stands for (§9). */
export function zookeeperKind(code: number): DbErrorCode {
  switch (code) {
    case ZK.NO_NODE:
      return 'not-found';
    case ZK.NO_AUTH:
    case ZK.INVALID_ACL:
    case ZK.NOT_READ_ONLY:
    case ZK.QUOTA_EXCEEDED:
      return 'permission-denied';
    case ZK.AUTH_FAILED:
      return 'auth-failed';
    case ZK.BAD_VERSION:
    case ZK.NODE_EXISTS:
    case ZK.NOT_EMPTY:
    case ZK.NO_CHILDREN_FOR_EPHEMERALS:
      return 'constraint';
    case ZK.BAD_ARGUMENTS:
      return 'syntax';
    case ZK.OPERATION_TIMEOUT:
      return 'timeout';
    case ZK.CONNECTION_LOSS:
    case ZK.SESSION_EXPIRED:
    case ZK.SESSION_MOVED:
    case ZK.CLOSING:
      return 'connection-failed';
    default:
      return 'internal';
  }
}

/** The words for a code, with the path it was about. */
export function zookeeperText(code: number, path: string): string {
  switch (code) {
    case ZK.NO_NODE:
      return msg('The znode "{0}" does not exist', path);
    case ZK.NO_AUTH:
      return msg('Not allowed to do this with "{0}": its ACL does not let this user', path);
    case ZK.BAD_VERSION:
      return msg('The znode "{0}" changed meanwhile: its version is not the one expected', path);
    case ZK.NODE_EXISTS:
      return msg('The znode "{0}" already exists', path);
    case ZK.NOT_EMPTY:
      return msg('The znode "{0}" has children: delete them first', path);
    case ZK.NO_CHILDREN_FOR_EPHEMERALS:
      return msg('The znode "{0}" is ephemeral: it cannot have children', path);
    case ZK.SESSION_EXPIRED:
      return msg('The ZooKeeper session expired: connect again');
    case ZK.AUTH_FAILED:
      return msg('ZooKeeper refused the user and password');
    case ZK.INVALID_ACL:
      return msg('ZooKeeper refused the ACL of "{0}"', path);
    case ZK.BAD_ARGUMENTS:
      return msg(
        'ZooKeeper refused the request for "{0}": the path or the data is not valid',
        path,
      );
    case ZK.NOT_READ_ONLY:
      return msg('The server is read-only (it has lost its quorum): nothing can be changed');
    case ZK.QUOTA_EXCEEDED:
      return msg('The quota of "{0}" is exceeded', path);
    case ZK.CONNECTION_LOSS:
      return msg('The connection to ZooKeeper was lost');
    default:
      return msg('ZooKeeper failed on "{0}" (error {1})', path, code);
  }
}

export function zookeeperFailure(code: number, path: string): DbError {
  return new DbError(zookeeperKind(code), zookeeperText(code, path), { driverCode: code });
}
