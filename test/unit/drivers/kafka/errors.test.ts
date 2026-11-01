import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { kafkaFailure } from '../../../../src/drivers/kafka/errors';
import { kafkaJsError } from '../../../helpers/fake-kafka';

describe('kafkaFailure', () => {
  it('passes our own errors through', () => {
    const own = new DbError('timeout', 'slow');
    expect(kafkaFailure(own)).toBe(own);
  });

  it.each([
    ['UNKNOWN_TOPIC_OR_PARTITION', 'not-found'],
    ['GROUP_ID_NOT_FOUND', 'not-found'],
    ['INVALID_TOPIC_EXCEPTION', 'syntax'],
    ['TOPIC_ALREADY_EXISTS', 'constraint'],
    ['TOPIC_AUTHORIZATION_FAILED', 'permission-denied'],
    ['GROUP_AUTHORIZATION_FAILED', 'permission-denied'],
    ['CLUSTER_AUTHORIZATION_FAILED', 'permission-denied'],
    ['SASL_AUTHENTICATION_FAILED', 'auth-failed'],
    ['UNSUPPORTED_SASL_MECHANISM', 'auth-failed'],
    ['REQUEST_TIMED_OUT', 'timeout'],
    ['INVALID_PARTITIONS', 'syntax'],
    ['INVALID_REPLICATION_FACTOR', 'syntax'],
    ['MESSAGE_TOO_LARGE', 'syntax'],
    ['LEADER_NOT_AVAILABLE', 'busy'],
    ['NOT_CONTROLLER', 'busy'],
  ] as const)('reads the broker’s %s as %s', (type, code) => {
    const error = kafkaFailure(kafkaJsError('KafkaJSProtocolError', 'x', { type }));
    expect(error).toMatchObject({ code, driverCode: type });
  });

  it('keeps an error of a name it does not know as internal, with its type', () => {
    expect(
      kafkaFailure(kafkaJsError('KafkaJSProtocolError', 'odd', { type: 'SOMETHING_NEW' })),
    ).toMatchObject({ code: 'internal', driverCode: 'SOMETHING_NEW' });
  });

  it('reads a failed sign-in', () => {
    const error = kafkaFailure(kafkaJsError('KafkaJSSASLAuthenticationError', 'bad password'));
    expect(error.code).toBe('auth-failed');
    expect(error.message).toMatch(/bad password/u);
  });

  it('reads a lost link as a connection failure', () => {
    expect(
      kafkaFailure(
        kafkaJsError('KafkaJSConnectionError', 'Connection error', { code: 'ECONNREFUSED' }),
      ),
    ).toMatchObject({ code: 'connection-failed' });
    expect(kafkaFailure(kafkaJsError('KafkaJSConnectionClosedError', 'closed'))).toMatchObject({
      code: 'connection-failed',
    });
  });

  it('reads a timeout', () => {
    expect(kafkaFailure(kafkaJsError('KafkaJSRequestTimeoutError', 'slow')).code).toBe('timeout');
    expect(kafkaFailure(kafkaJsError('KafkaJSConnectionTimeoutError', 'slow')).code).toBe(
      'timeout',
    );
  });

  it('looks inside "retries exceeded" for the error that was retried', () => {
    const inner = kafkaJsError('KafkaJSProtocolError', 'no', {
      type: 'TOPIC_AUTHORIZATION_FAILED',
    });
    const outer = kafkaJsError('KafkaJSNumberOfRetriesExceeded', 'gave up', { cause: inner });
    expect(kafkaFailure(outer).code).toBe('permission-denied');
  });

  it('looks inside a non-retriable error as well', () => {
    const inner = kafkaJsError('KafkaJSProtocolError', 'no', { type: 'TOPIC_ALREADY_EXISTS' });
    expect(kafkaFailure(kafkaJsError('KafkaJSNonRetriableError', 'x', { cause: inner })).code).toBe(
      'constraint',
    );
  });

  it('says a broker that does not speak a request is unsupported', () => {
    expect(kafkaFailure(kafkaJsError('KafkaJSServerDoesNotSupportApiKey', 'old broker')).code).toBe(
      'unsupported',
    );
  });

  it('turns other KafkaJS errors into internal ones and others into network errors', () => {
    expect(kafkaFailure(kafkaJsError('KafkaJSSomething', 'odd')).code).toBe('internal');
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    expect(kafkaFailure(refused).code).toBe('connection-failed');
  });
});
