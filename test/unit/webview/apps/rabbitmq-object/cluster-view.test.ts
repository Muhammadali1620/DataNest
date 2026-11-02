import { describe, expect, it } from 'vitest';
import {
  listenerAddress,
  meterTone,
  usedPercent,
} from '../../../../../webview/src/apps/rabbitmq-object/cluster-view';

describe('usedPercent', () => {
  it('rounds the share and keeps it between 0 and 100', () => {
    expect(usedPercent(1, 3)).toBe(33);
    expect(usedPercent(2, 3)).toBe(67);
    expect(usedPercent(5, 5)).toBe(100);
    expect(usedPercent(9, 5)).toBe(100);
  });

  it('shows nothing used when the node reports no total or no use', () => {
    expect(usedPercent(5, 0)).toBe(0);
    expect(usedPercent(5, -1)).toBe(0);
    expect(usedPercent(0, 5)).toBe(0);
    expect(usedPercent(-3, 5)).toBe(0);
  });
});

describe('meterTone', () => {
  it('goes from ok to warn at 70 and to bad at 90', () => {
    expect(meterTone(0)).toBe('ok');
    expect(meterTone(69)).toBe('ok');
    expect(meterTone(70)).toBe('warn');
    expect(meterTone(89)).toBe('warn');
    expect(meterTone(90)).toBe('bad');
  });

  it('is bad at an alarm whatever the share', () => {
    expect(meterTone(5, true)).toBe('bad');
  });
});

describe('listenerAddress', () => {
  it('writes every address as a star and brackets an IPv6 one', () => {
    expect(listenerAddress('::', 5672)).toBe('*:5672');
    expect(listenerAddress('0.0.0.0', 1)).toBe('*:1');
    expect(listenerAddress('', 2)).toBe('*:2');
    expect(listenerAddress('::1', 5671)).toBe('[::1]:5671');
    expect(listenerAddress('10.0.0.1', 15672)).toBe('10.0.0.1:15672');
  });
});
