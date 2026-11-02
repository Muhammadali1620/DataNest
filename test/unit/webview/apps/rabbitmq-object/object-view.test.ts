import { describe, expect, it } from 'vitest';
import {
  displayName,
  parseHeaders,
  parseTags,
  sharePercent,
  stateTone,
} from '../../../../../webview/src/apps/rabbitmq-object/object-view';

describe('RabbitMQ page helpers (V13.26)', () => {
  it('draws a part of the whole as a percentage, never out of range', () => {
    expect(sharePercent(1, 4)).toBe(25);
    expect(sharePercent(1, 3)).toBe(33);
    expect(sharePercent(4, 4)).toBe(100);
    expect(sharePercent(9, 4)).toBe(100);
    expect(sharePercent(0, 4)).toBe(0);
    expect(sharePercent(-3, 4)).toBe(0);
    expect(sharePercent(3, 0)).toBe(0);
  });

  it('reads `name: value` lines into headers', () => {
    expect(parseHeaders('trace-id: 42\n\n  x-flag  \nurl: http://a:80/b\r\nempty:')).toEqual([
      { name: 'trace-id', value: '42' },
      { name: 'x-flag', value: '' },
      { name: 'url', value: 'http://a:80/b' },
      { name: 'empty', value: '' },
    ]);
    expect(parseHeaders('')).toEqual([]);
    expect(parseHeaders('  \n \n')).toEqual([]);
  });

  it('names the default exchange, which has no name of its own', () => {
    expect(displayName('', '(AMQP default)')).toBe('(AMQP default)');
    expect(displayName('events', '(AMQP default)')).toBe('events');
  });

  it('tells a healthy queue from a struggling and a dead one', () => {
    expect(stateTone('running')).toBe('success');
    expect(stateTone('idle')).toBe('success');
    expect(stateTone('flow')).toBe('warning');
    expect(stateTone('minority')).toBe('warning');
    expect(stateTone('blocked')).toBe('warning');
    expect(stateTone('blocking')).toBe('warning');
    expect(stateTone('down')).toBe('error');
    expect(stateTone('crashed')).toBe('error');
    expect(stateTone('stopped')).toBe('error');
    expect(stateTone('')).toBe('outline');
    expect(stateTone('something new')).toBe('outline');
  });
});

describe('parseTags', () => {
  it('divides by commas and spaces and drops blanks', () => {
    expect(parseTags('management, policymaker  monitoring,')).toEqual([
      'management',
      'policymaker',
      'monitoring',
    ]);
    expect(parseTags('')).toEqual([]);
    expect(parseTags(' , ,')).toEqual([]);
    expect(parseTags('administrator')).toEqual(['administrator']);
  });
});
