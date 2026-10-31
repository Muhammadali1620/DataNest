import { describe, expect, it } from 'vitest';
import {
  filterSections,
  formatPercent,
  formatUptime,
  shareOf,
} from '../../../../../webview/src/apps/redis-info/info-view';

const NODE = {
  name: 'n',
  sections: [
    {
      name: 'Server',
      fields: [
        ['redis_version', '7.4.6'],
        ['os', 'Linux'],
      ],
    },
    { name: 'Memory', fields: [['used_memory', '1024']] },
  ],
  summary: { keys: 0 },
};

describe('info view', () => {
  it('says uptime the way people do', () => {
    expect(formatUptime(42)).toBe('42s');
    expect(formatUptime(125)).toBe('2m 5s');
    expect(formatUptime(3 * 3600 + 120)).toBe('3h 2m');
    expect(formatUptime(2 * 86_400 + 3600)).toBe('2d 1h');
  });

  it('writes shares as percents', () => {
    expect(formatPercent(0.975)).toBe('97.5%');
  });

  it('keeps fields whose name or value has the text, and drops empty sections', () => {
    expect(filterSections(NODE, ' LINUX ')).toEqual([
      { name: 'Server', fields: [['os', 'Linux']] },
    ]);
    expect(filterSections(NODE, 'memory')).toEqual([
      { name: 'Memory', fields: [['used_memory', '1024']] },
    ]);
    expect(filterSections(NODE, '')).toBe(NODE.sections);
    expect(filterSections(NODE, 'zzz')).toEqual([]);
  });

  it('says how full a meter is, between none and all', () => {
    expect(shareOf(2048, 4096)).toBe(0.5);
    expect(shareOf(0, 4096)).toBe(0);
    // Over the limit (it happens with maxmemory lowered at run time): full, not more.
    expect(shareOf(5000, 4096)).toBe(1);
    expect(shareOf(-1, 10)).toBe(0);
  });

  it('has no meter without a limit or a reading', () => {
    expect(shareOf(2048, 0)).toBeUndefined();
    expect(shareOf(2048, undefined)).toBeUndefined();
    expect(shareOf(undefined, 4096)).toBeUndefined();
    expect(shareOf(Number.NaN, 4096)).toBeUndefined();
    expect(shareOf(1, Number.NaN)).toBeUndefined();
  });
});
