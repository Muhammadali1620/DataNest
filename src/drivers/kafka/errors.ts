// What kafkajs throws, as the app's own errors (§9). kafkajs names its errors
// (`KafkaJSConnectionError`, `KafkaJSProtocolError`, …) and a protocol error carries the
// broker's error name in `type` (`TOPIC_ALREADY_EXISTS`); both say more than the message.

import { DbError, type DbErrorCode, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';
import { networkFailure } from '../elasticsearch/errors';

interface KafkaJsError {
  readonly name?: unknown;
  readonly type?: unknown;
  readonly message?: unknown;
  readonly code?: unknown;
  readonly retriable?: unknown;
  readonly cause?: unknown;
}

/** The broker's error names → the kinds of error the app understands. */
function protocolKind(type: string): DbErrorCode | undefined {
  switch (type) {
    case 'UNKNOWN_TOPIC_OR_PARTITION':
    case 'GROUP_ID_NOT_FOUND':
    case 'INVALID_TOPIC_EXCEPTION':
      return type === 'INVALID_TOPIC_EXCEPTION' ? 'syntax' : 'not-found';
    case 'TOPIC_ALREADY_EXISTS':
      return 'constraint';
    case 'SECURITY_DISABLED':
    case 'TOPIC_AUTHORIZATION_FAILED':
    case 'GROUP_AUTHORIZATION_FAILED':
    case 'CLUSTER_AUTHORIZATION_FAILED':
      return 'permission-denied';
    case 'SASL_AUTHENTICATION_FAILED':
    case 'ILLEGAL_SASL_STATE':
    case 'UNSUPPORTED_SASL_MECHANISM':
      return 'auth-failed';
    case 'REQUEST_TIMED_OUT':
      return 'timeout';
    case 'INVALID_PARTITIONS':
    case 'INVALID_REPLICATION_FACTOR':
    case 'INVALID_REQUEST':
    case 'INVALID_CONFIG':
    case 'MESSAGE_TOO_LARGE':
    case 'INVALID_RECORD':
      return 'syntax';
    case 'LEADER_NOT_AVAILABLE':
    case 'NOT_LEADER_OR_FOLLOWER':
    case 'NOT_CONTROLLER':
    case 'COORDINATOR_NOT_AVAILABLE':
    case 'NOT_COORDINATOR':
    case 'NETWORK_EXCEPTION':
      return 'busy';
    default:
      return undefined;
  }
}

/** Turns anything the client threw into a DbError the app can show. */
export function kafkaFailure(error: unknown): DbError {
  if (error instanceof DbError) {
    return error;
  }
  const e = (error ?? {}) as KafkaJsError;
  const name = typeof e.name === 'string' ? e.name : '';
  const type = typeof e.type === 'string' ? e.type : '';
  const text = errorMessage(error);
  // "Number of retries exceeded" wraps the error that was retried; that is the news.
  if (name === 'KafkaJSNumberOfRetriesExceeded' && e.cause !== undefined && e.cause !== error) {
    return kafkaFailure(e.cause);
  }
  if (name === 'KafkaJSSASLAuthenticationError' || type === 'SASL_AUTHENTICATION_FAILED') {
    return new DbError('auth-failed', msg('Sign-in to Kafka failed: {0}', text), {
      cause: error,
      driverCode: type || name,
    });
  }
  if (
    name === 'KafkaJSConnectionError' ||
    name === 'KafkaJSConnectionClosedError' ||
    name === 'KafkaJSBrokerNotFound' ||
    name === 'KafkaJSServerDoesNotSupportApiKey'
  ) {
    if (name === 'KafkaJSServerDoesNotSupportApiKey') {
      return new DbError('unsupported', text, { cause: error, driverCode: name });
    }
    // A lost link is a connection failure, with or without Node's code behind it.
    const network = networkFailure(
      Object.assign(new Error(text), {
        ...(typeof e.code === 'string' ? { code: e.code } : {}),
        cause: error,
      }),
    );
    return network.code === 'connection-failed'
      ? network
      : new DbError('connection-failed', text, { cause: error, driverCode: name });
  }
  if (name === 'KafkaJSNonRetriableError') {
    return e.cause !== undefined && e.cause !== error
      ? kafkaFailure(e.cause)
      : new DbError('internal', text, { cause: error, driverCode: name });
  }
  if (name === 'KafkaJSRequestTimeoutError' || name === 'KafkaJSConnectionTimeoutError') {
    return new DbError('timeout', text, { cause: error, driverCode: name });
  }
  const kind = protocolKind(type);
  if (kind !== undefined) {
    return new DbError(kind, text, { cause: error, driverCode: type });
  }
  if (name.startsWith('KafkaJS')) {
    return new DbError('internal', text, { cause: error, driverCode: type || name });
  }
  return networkFailure(error);
}
