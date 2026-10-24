import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  DEFAULT_LOG_LEVEL,
  isLogLevel,
  LOG_LEVELS,
  parseLogLevel,
  SinkLogger,
  type LogLevel,
} from '../../../../src/core/logging/logger';
import { MemorySink } from '../../../helpers/fakes';

const NOW = new Date('2026-10-24T10:20:30.456Z');

function create(level?: LogLevel): { logger: SinkLogger; sink: MemorySink } {
  const sink = new MemorySink();
  const logger = new SinkLogger({ sink, now: () => NOW, ...(level ? { level } : {}) });
  return { logger, sink };
}

function logAll(logger: SinkLogger): void {
  logger.error('e');
  logger.warn('w');
  logger.info('i');
  logger.debug('d');
}

describe('log levels', () => {
  it('are ordered from the most to the least important', () => {
    expect(LOG_LEVELS).toEqual(['error', 'warn', 'info', 'debug']);
    expect(DEFAULT_LOG_LEVEL).toBe('info');
  });

  it('recognizes only known levels', () => {
    for (const level of LOG_LEVELS) {
      expect(isLogLevel(level)).toBe(true);
    }
    for (const value of ['INFO', 'trace', '', null, undefined, 1, {}]) {
      expect(isLogLevel(value)).toBe(false);
    }
  });

  it('parses settings with a fallback', () => {
    expect(parseLogLevel('debug')).toBe('debug');
    expect(parseLogLevel('verbose')).toBe('info');
    expect(parseLogLevel(undefined)).toBe('info');
    expect(parseLogLevel(42, 'warn')).toBe('warn');
  });
});

describe('SinkLogger', () => {
  it('uses the info level by default', () => {
    const { logger, sink } = create();
    expect(logger.level).toBe('info');
    logAll(logger);
    expect(sink.lines.map((line) => line.split(' ')[1])).toEqual(['[error]', '[warn]', '[info]']);
  });

  it.each([
    ['error', ['e']],
    ['warn', ['e', 'w']],
    ['info', ['e', 'w', 'i']],
    ['debug', ['e', 'w', 'i', 'd']],
  ] as const)('writes only messages at or above %s', (level, expected) => {
    const { logger, sink } = create(level);
    logAll(logger);
    expect(sink.lines.map((line) => line.slice(line.lastIndexOf(' ') + 1))).toEqual(expected);
  });

  it('formats lines as "<ISO time> [level] message"', () => {
    const { logger, sink } = create();
    logger.info('Connected');
    expect(sink.lines).toEqual(['2026-10-24T10:20:30.456Z [info] Connected']);
  });

  it('reports whether a level is enabled', () => {
    const { logger } = create('warn');
    expect(logger.isEnabled('error')).toBe(true);
    expect(logger.isEnabled('warn')).toBe(true);
    expect(logger.isEnabled('info')).toBe(false);
  });

  it('changes the level at runtime', () => {
    const { logger, sink } = create('error');
    logger.debug('hidden');
    logger.setLevel('debug');
    logger.debug('shown');
    expect(sink.lines).toEqual(['2026-10-24T10:20:30.456Z [debug] shown']);
  });

  it('appends error details on the following lines', () => {
    const { logger, sink } = create();
    logger.error('Query failed', new DbError('syntax', 'near FROM', { sqlState: '42601' }));
    const [line] = sink.lines;
    expect(line?.split('\n').slice(0, 3)).toEqual([
      '2026-10-24T10:20:30.456Z [error] Query failed',
      'DbError [syntax]: near FROM',
      '  sqlState: 42601',
    ]);
  });

  it('accepts error details on warnings too', () => {
    const { logger, sink } = create();
    logger.warn('Retrying', 'socket hang up');
    expect(sink.lines).toEqual(['2026-10-24T10:20:30.456Z [warn] Retrying\nsocket hang up']);
  });

  it('does not format filtered messages', () => {
    const { logger, sink } = create('error');
    let described = false;
    const error = {
      toJSON: () => {
        described = true;
        return {};
      },
    };
    logger.warn('skipped', error);
    expect(described).toBe(false);
    expect(sink.lines).toEqual([]);
  });

  it('redacts secrets in messages and error details', () => {
    const { logger, sink } = create();
    logger.error(
      'Cannot connect to mysql://root:hunter2@db',
      new Error('auth failed for password=hunter2'),
    );
    expect(sink.text).not.toContain('hunter2');
    expect(sink.text).toContain('mysql://root:***@db');
    expect(sink.text).toContain('password=***');
  });

  it('uses the system clock by default', () => {
    const sink = new MemorySink();
    const before = Date.now();
    new SinkLogger({ sink }).info('now');
    const stamp = Date.parse(sink.lines[0]?.split(' ')[0] ?? '');
    expect(stamp).toBeGreaterThanOrEqual(before - 1);
    expect(stamp).toBeLessThanOrEqual(Date.now());
  });

  it('uses the current time for every line', () => {
    const sink = new MemorySink();
    const times = [new Date('2026-01-01T00:00:00.000Z'), new Date('2026-01-01T00:00:01.000Z')];
    const logger = new SinkLogger({ sink, now: () => times.shift() ?? NOW });
    logger.info('a');
    logger.info('b');
    expect(sink.lines).toEqual([
      '2026-01-01T00:00:00.000Z [info] a',
      '2026-01-01T00:00:01.000Z [info] b',
    ]);
  });

  describe('child loggers', () => {
    it('prefix messages with nested scopes', () => {
      const { logger, sink } = create();
      const mysql = logger.child('mysql');
      mysql.info('connected');
      mysql.child('session-1').info('query');
      logger.info('root');
      expect(sink.lines).toEqual([
        '2026-10-24T10:20:30.456Z [info] [mysql] connected',
        '2026-10-24T10:20:30.456Z [info] [mysql] [session-1] query',
        '2026-10-24T10:20:30.456Z [info] root',
      ]);
    });

    it('share the level with the parent in both directions', () => {
      const { logger, sink } = create('info');
      const child = logger.child('x');
      logger.setLevel('error');
      child.info('hidden');
      child.setLevel('debug');
      logger.debug('shown');
      expect(child.level).toBe('debug');
      expect(sink.lines).toEqual(['2026-10-24T10:20:30.456Z [debug] shown']);
    });

    it('do not change the parent scope', () => {
      const { logger, sink } = create();
      logger.child('a');
      logger.info('root');
      expect(sink.lines).toEqual(['2026-10-24T10:20:30.456Z [info] root']);
    });
  });
});
