import { describe, expect, it } from 'vitest';
import {
  aclText,
  KIND_TONE,
  timeText,
} from '../../../../../webview/src/apps/zookeeper-node/node-view';

describe('aclText', () => {
  it('writes the scheme and the id, and only the scheme when there is no id', () => {
    expect(aclText({ perms: 31, scheme: 'world', id: 'anyone' })).toBe('world:anyone');
    expect(aclText({ perms: 31, scheme: 'digest', id: 'u:hash=' })).toBe('digest:u:hash=');
    expect(aclText({ perms: 31, scheme: 'auth', id: '' })).toBe('auth:');
  });
});

describe('timeText', () => {
  it('writes a time the way the locale does', () => {
    const when = 1_700_000_000_000;
    expect(timeText(when, 'en-US')).toBe(new Date(when).toLocaleString('en-US'));
    expect(timeText(when, 'ru-RU')).toBe(new Date(when).toLocaleString('ru-RU'));
  });

  it('writes a dash for a time that is not one', () => {
    expect(timeText(0)).toBe('—');
    expect(timeText(-5)).toBe('—');
    expect(timeText(Number.NaN)).toBe('—');
    expect(timeText(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('KIND_TONE', () => {
  it('has a class for each kind of znode', () => {
    expect(Object.keys(KIND_TONE).sort()).toEqual(['container', 'ephemeral', 'persistent', 'ttl']);
  });
});
