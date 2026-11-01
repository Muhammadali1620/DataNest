import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { redisTypeIcon } from '../../../../src/vscode/tree/redis-type-icon';
import { ROOT } from '../../../helpers/repo';

describe('redisTypeIcon', () => {
  it('keeps the icon of each built-in type', () => {
    expect(redisTypeIcon('string')).toEqual({ icon: 'symbol-string' });
    expect(redisTypeIcon('hash')).toEqual({ icon: 'symbol-structure' });
    expect(redisTypeIcon('list')).toEqual({ icon: 'list-ordered' });
    expect(redisTypeIcon('set')).toEqual({ icon: 'symbol-array' });
    expect(redisTypeIcon('zset')).toEqual({ icon: 'list-filter' });
    expect(redisTypeIcon('stream')).toEqual({ icon: 'pulse' });
  });

  it('gives a RedisJSON key a yellow JSON icon of its own (V13.14)', () => {
    expect(redisTypeIcon('ReJSON-RL')).toEqual({ icon: 'json', color: 'charts.yellow' });
  });

  it('draws a key whose type is not known yet as a key, and another module as an extension', () => {
    expect(redisTypeIcon(undefined)).toEqual({ icon: 'key' });
    expect(redisTypeIcon('MBbloom--')).toEqual({ icon: 'extensions' });
    expect(redisTypeIcon('TSDB-TYPE')).toEqual({ icon: 'extensions' });
  });

  it('uses codicons the editor has', () => {
    const csv = readFileSync(join(ROOT, 'node_modules/@vscode/codicons/dist/codicon.csv'), 'utf8');
    const names = new Set(csv.split('\n').map((line) => line.split(',')[0]));
    for (const type of [
      'string',
      'hash',
      'list',
      'set',
      'zset',
      'stream',
      'ReJSON-RL',
      undefined,
      'x',
    ]) {
      expect(names.has(redisTypeIcon(type).icon), String(type)).toBe(true);
    }
  });
});
