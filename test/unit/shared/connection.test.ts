import { describe, expect, it } from 'vitest';
import {
  connectionProblems,
  DEFAULT_PORTS,
  describeTarget,
  DRIVER_IDS,
  effectivePort,
  isDriverId,
  isFileDriver,
} from '../../../src/shared/connection';

describe('isDriverId', () => {
  it('accepts every known driver id', () => {
    for (const id of DRIVER_IDS) {
      expect(isDriverId(id)).toBe(true);
    }
  });

  it('rejects unknown ids and non-strings', () => {
    expect(isDriverId('oracle')).toBe(false);
    expect(isDriverId('')).toBe(false);
    expect(isDriverId(undefined)).toBe(false);
    expect(isDriverId(42)).toBe(false);
    expect(isDriverId(null)).toBe(false);
  });
});

describe('isFileDriver', () => {
  it('treats sqlite as file-based and network drivers as not', () => {
    expect(isFileDriver('sqlite')).toBe(true);
    expect(isFileDriver('mysql')).toBe(false);
    expect(isFileDriver('postgres')).toBe(false);
  });
});

describe('effectivePort', () => {
  it('returns the explicit port when set', () => {
    expect(effectivePort({ name: 'a', driver: 'mysql', host: 'h', port: 7306 })).toBe(7306);
  });

  it('falls back to the default port of the driver', () => {
    expect(effectivePort({ name: 'a', driver: 'mysql', host: 'h' })).toBe(3306);
    expect(effectivePort({ name: 'a', driver: 'postgres', host: 'h' })).toBe(5432);
  });

  it('returns undefined for file drivers without a port concept', () => {
    expect(DEFAULT_PORTS.sqlite).toBeUndefined();
    expect(effectivePort({ name: 'a', driver: 'sqlite', file: '/db.sqlite' })).toBeUndefined();
  });
});

describe('connectionProblems', () => {
  it('accepts a valid network config', () => {
    expect(
      connectionProblems({ name: 'Local', driver: 'postgres', host: 'localhost', port: 7432 }),
    ).toEqual([]);
  });

  it('accepts a valid file config', () => {
    expect(connectionProblems({ name: 'DB', driver: 'sqlite', file: '/tmp/x.db' })).toEqual([]);
  });

  it('requires a non-blank name', () => {
    expect(connectionProblems({ name: '  ', driver: 'sqlite', file: '/x' })).toEqual([
      'name-empty',
    ]);
  });

  it('requires a host for network drivers', () => {
    expect(connectionProblems({ name: 'a', driver: 'mysql' })).toEqual(['host-empty']);
    expect(connectionProblems({ name: 'a', driver: 'mysql', host: '  ' })).toEqual(['host-empty']);
  });

  it('requires a file for file drivers and ignores host there', () => {
    expect(connectionProblems({ name: 'a', driver: 'sqlite' })).toEqual(['file-empty']);
    expect(connectionProblems({ name: 'a', driver: 'sqlite', host: 'ignored' })).toEqual([
      'file-empty',
    ]);
  });

  it('rejects out-of-range and fractional ports', () => {
    for (const port of [0, -1, 65_536, 1.5]) {
      expect(connectionProblems({ name: 'a', driver: 'mysql', host: 'h', port })).toEqual([
        'port-invalid',
      ]);
    }
  });

  it('collects several problems at once', () => {
    expect(connectionProblems({ name: '', driver: 'mysql', port: 0 })).toEqual([
      'name-empty',
      'host-empty',
      'port-invalid',
    ]);
  });
});

describe('describeTarget', () => {
  it('shows user@host:port for network drivers', () => {
    expect(
      describeTarget({ name: 'a', driver: 'mysql', host: 'db.local', port: 7306, user: 'root' }),
    ).toBe('root@db.local:7306');
  });

  it('uses the default port when none is set', () => {
    expect(describeTarget({ name: 'a', driver: 'postgres', host: 'h' })).toBe('h:5432');
  });

  it('omits the user part when the user is empty', () => {
    expect(describeTarget({ name: 'a', driver: 'mysql', host: 'h', user: '' })).toBe('h:3306');
  });

  it('shows the file path for file drivers', () => {
    expect(describeTarget({ name: 'a', driver: 'sqlite', file: '/tmp/x.db' })).toBe('/tmp/x.db');
    expect(describeTarget({ name: 'a', driver: 'sqlite' })).toBe('');
  });
});
