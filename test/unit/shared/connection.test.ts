import { describe, expect, it } from 'vitest';
import {
  connectionProblems,
  filterSupport,
  optionProblems,
  optionSupport,
  DEFAULT_PORTS,
  describeTunnel,
  DEFAULT_SSH_PORT,
  effectiveSshPort,
  HOP_ID_PATTERN,
  MAX_SSH_JUMPS,
  newHopId,
  type SshHop,
  sshHopProblems,
  sshHopsOf,
  describeTarget,
  DRIVER_IDS,
  effectivePort,
  isDriverId,
  isFileDriver,
  driverFamily,
  isSqlDriver,
  SQL_DRIVER_IDS,
  redisModeOf,
  redisProblems,
  MAX_REDIS_NODES,
} from '../../../src/shared/connection';

describe('isDriverId', () => {
  it('accepts every known driver id', () => {
    for (const id of DRIVER_IDS) {
      expect(isDriverId(id)).toBe(true);
    }
  });

  it('rejects unknown ids and non-strings', () => {
    expect(isDriverId('db2')).toBe(false);
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

describe('SSH hops', () => {
  const hop: SshHop = { id: 'main', host: 'bastion', user: 'deploy', auth: 'password' };

  it('lists the hop of a config, none for a direct one', () => {
    expect(sshHopsOf({ name: 'a', driver: 'mysql', host: 'h', ssh: hop })).toEqual([hop]);
    expect(sshHopsOf({ name: 'a', driver: 'mysql', host: 'h' })).toEqual([]);
  });

  it('uses port 22 unless told otherwise', () => {
    expect(DEFAULT_SSH_PORT).toBe(22);
    expect(effectiveSshPort(hop)).toBe(22);
    expect(effectiveSshPort({ ...hop, port: 2222 })).toBe(2222);
  });

  it('makes ids that fit into a secret key and differ', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newHopId()));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(HOP_ID_PATTERN.test(id)).toBe(true);
    }
  });

  it('accepts a complete hop for every method', () => {
    expect(sshHopProblems(hop)).toEqual([]);
    expect(sshHopProblems({ ...hop, auth: 'key', keyFile: '~/.ssh/id' })).toEqual([]);
    expect(sshHopProblems({ ...hop, auth: 'agent' })).toEqual([]);
  });

  it('names every missing or wrong field', () => {
    expect(
      sshHopProblems({ id: 'x y', host: ' ', port: 0, user: '', auth: 'key', keyFile: ' ' }),
    ).toEqual([
      'ssh-host-empty',
      'ssh-port-invalid',
      'ssh-user-empty',
      'ssh-key-empty',
      'ssh-id-invalid',
    ]);
    expect(sshHopProblems({ ...hop, port: 70_000 })).toEqual(['ssh-port-invalid']);
    expect(sshHopProblems({ ...hop, id: 'a'.repeat(65) })).toEqual(['ssh-id-invalid']);
  });

  it('adds hop problems to the connection, but not for file databases', () => {
    const broken = { ...hop, host: '' };
    expect(connectionProblems({ name: 'a', driver: 'mysql', host: 'h', ssh: broken })).toEqual([
      'ssh-host-empty',
    ]);
    expect(connectionProblems({ name: 'a', driver: 'sqlite', file: '/f', ssh: broken })).toEqual(
      [],
    );
  });
});

describe('describeTunnel', () => {
  it('names the SSH server a connection goes through, never a secret', () => {
    expect(
      describeTunnel({
        name: 'a',
        driver: 'mysql',
        host: 'db',
        ssh: { id: 'm', host: 'bastion', user: 'deploy', auth: 'password' },
      }),
    ).toBe('deploy@bastion:22');
    expect(describeTunnel({ name: 'a', driver: 'mysql', host: 'db' })).toBeUndefined();
  });
});

describe('jump hosts', () => {
  const jump = (id: string): SshHop => ({ id, host: `${id}.example`, user: 'j', auth: 'agent' });
  const server: SshHop = { id: 'main', host: 'inner', user: 'deploy', auth: 'password' };

  it('connects the jumps first, then the server', () => {
    const hops = sshHopsOf({
      name: 'a',
      driver: 'mysql',
      host: 'db',
      ssh: { ...server, jumps: [jump('a'), jump('b')] },
    });
    expect(hops.map((hop) => hop.id)).toEqual(['a', 'b', 'main']);
    expect(hops[2]).not.toHaveProperty('jumps');
  });

  it('describes the whole route', () => {
    expect(
      describeTunnel({
        name: 'a',
        driver: 'mysql',
        host: 'db',
        ssh: { ...server, jumps: [jump('a')] },
      }),
    ).toBe('j@a.example:22 → deploy@inner:22');
  });

  it('checks every jump and refuses ids used twice', () => {
    const input = { name: 'a', driver: 'mysql' as const, host: 'db' };
    expect(
      connectionProblems({ ...input, ssh: { ...server, jumps: [{ ...jump('a'), host: '' }] } }),
    ).toEqual(['ssh-host-empty']);
    expect(connectionProblems({ ...input, ssh: { ...server, jumps: [jump('main')] } })).toEqual([
      'ssh-id-invalid',
    ]);
  });

  it(`allows at most ${MAX_SSH_JUMPS} jumps`, () => {
    const input = { name: 'a', driver: 'mysql' as const, host: 'db' };
    const jumps = Array.from({ length: MAX_SSH_JUMPS + 1 }, (_, i) => jump(`j${i}`));
    expect(connectionProblems({ ...input, ssh: { ...server, jumps: jumps.slice(1) } })).toEqual([]);
    expect(connectionProblems({ ...input, ssh: { ...server, jumps } })).toEqual([
      'ssh-too-many-jumps',
    ]);
  });
});

describe('SSL settings', () => {
  const input = { name: 'a', driver: 'postgres' as const, host: 'db' };

  it('accepts a mode alone or with a full client certificate', () => {
    expect(connectionProblems({ ...input, ssl: { mode: 'require' } })).toEqual([]);
    expect(
      connectionProblems({ ...input, ssl: { mode: 'verify-full', cert: '/c', key: '/k' } }),
    ).toEqual([]);
  });

  it('wants the certificate and its key together', () => {
    expect(connectionProblems({ ...input, ssl: { mode: 'require', cert: '/c' } })).toEqual([
      'ssl-cert-without-key',
    ]);
    expect(
      connectionProblems({ ...input, ssl: { mode: 'require', key: '/k', cert: ' ' } }),
    ).toEqual(['ssl-key-without-cert']);
  });
});

describe('session options (V4.9)', () => {
  it('accepts no options and every value in range', () => {
    expect(optionProblems(undefined)).toEqual([]);
    expect(
      optionProblems({
        connectTimeout: 1,
        queryTimeout: 0,
        keepAlive: 3600,
        timeZone: 'Europe/Berlin',
        charset: 'utf8mb4',
        initSql: 'SET a = 1',
      }),
    ).toEqual([]);
  });

  it('flags numbers out of range or not whole', () => {
    expect(optionProblems({ connectTimeout: 0 })).toEqual(['connect-timeout-invalid']);
    expect(optionProblems({ connectTimeout: 301 })).toEqual(['connect-timeout-invalid']);
    expect(optionProblems({ queryTimeout: -1 })).toEqual(['query-timeout-invalid']);
    expect(optionProblems({ queryTimeout: 1.5 })).toEqual(['query-timeout-invalid']);
    expect(optionProblems({ keepAlive: 3601 })).toEqual(['keep-alive-invalid']);
  });

  it('flags a time zone with control characters, a bad charset and long init SQL', () => {
    expect(optionProblems({ timeZone: 'UTC\n' })).toEqual(['time-zone-invalid']);
    expect(optionProblems({ timeZone: 'x'.repeat(65) })).toEqual(['time-zone-invalid']);
    expect(optionProblems({ charset: 'utf-8' })).toEqual(['charset-invalid']);
    expect(optionProblems({ charset: "latin1'" })).toEqual(['charset-invalid']);
    expect(optionProblems({ initSql: 'x'.repeat(20_001) })).toEqual(['init-sql-too-long']);
  });

  it('is part of the problems of a connection', () => {
    expect(
      connectionProblems({
        name: 'a',
        driver: 'sqlite',
        file: 'a.db',
        options: { queryTimeout: -5 },
      }),
    ).toEqual(['query-timeout-invalid']);
  });

  it('says which options each driver honours', () => {
    expect(optionSupport('mysql')).toEqual({
      connectTimeout: true,
      keepAlive: true,
      timeZone: true,
      charset: true,
      queryTimeout: true,
      tls: true,
    });
    expect(optionSupport('postgres').charset).toBe(false);
    expect(optionSupport('sqlite')).toEqual({
      connectTimeout: false,
      keepAlive: false,
      timeZone: false,
      charset: false,
      queryTimeout: true,
      tls: false,
    });
  });
});

describe('visibility filter (V4.10)', () => {
  it('accepts up to 100 patterns of 200 characters', () => {
    const fine = { name: 'a', driver: 'postgres' as const, host: 'h' };
    expect(
      connectionProblems({ ...fine, filter: { databases: Array(100).fill('x'.repeat(200)) } }),
    ).toEqual([]);
    expect(connectionProblems({ ...fine, filter: { databases: Array(101).fill('x') } })).toEqual([
      'filter-too-long',
    ]);
    expect(
      connectionProblems({
        ...fine,
        filter: { schemas: ['x'.repeat(201)], databases: ['y'.repeat(201)] },
      }),
    ).toEqual(['filter-too-long']);
  });

  it('says which lists each driver has', () => {
    expect(filterSupport('mysql')).toEqual({ databases: true, schemas: false });
    expect(filterSupport('postgres')).toEqual({ databases: true, schemas: true });
    expect(filterSupport('sqlite')).toEqual({ databases: false, schemas: false });
  });
});

describe('SQL Server connections (V6.2)', () => {
  it('is a known network driver on port 1433', () => {
    expect(isDriverId('mssql')).toBe(true);
    expect(isFileDriver('mssql')).toBe(false);
    expect(DEFAULT_PORTS.mssql).toBe(1433);
    expect(effectivePort({ name: 'n', driver: 'mssql', host: 'h' })).toBe(1433);
    expect(effectivePort({ name: 'n', driver: 'mssql', host: 'h', port: 7143 })).toBe(7143);
  });

  it('offers connect timeout and keep-alive, but no time zone or charset', () => {
    expect(optionSupport('mssql')).toEqual({
      connectTimeout: true,
      keepAlive: true,
      timeZone: false,
      charset: false,
      queryTimeout: true,
      tls: true,
    });
  });

  it('filters both databases and schemas', () => {
    expect(filterSupport('mssql')).toEqual({ databases: true, schemas: true });
  });
});

describe('ClickHouse connections (V6.3)', () => {
  it('is a network driver on the HTTP port 8123', () => {
    expect(isDriverId('clickhouse')).toBe(true);
    expect(isFileDriver('clickhouse')).toBe(false);
    expect(DEFAULT_PORTS.clickhouse).toBe(8123);
    expect(effectivePort({ name: 'c', driver: 'clickhouse', host: 'h' })).toBe(8123);
    expect(effectivePort({ name: 'c', driver: 'clickhouse', host: 'h', port: 8443 })).toBe(8443);
  });

  it('honours a time zone, but no character set', () => {
    expect(optionSupport('clickhouse')).toEqual({
      connectTimeout: true,
      keepAlive: true,
      timeZone: true,
      charset: false,
      queryTimeout: true,
      tls: true,
    });
  });

  it('filters databases only: ClickHouse has no schemas', () => {
    expect(filterSupport('clickhouse')).toEqual({ databases: true, schemas: false });
  });
});

describe('Oracle connections (V6.4)', () => {
  it('is a network driver on port 1521', () => {
    expect(isDriverId('oracle')).toBe(true);
    expect(DRIVER_IDS).toContain('oracle');
    expect(isFileDriver('oracle')).toBe(false);
    expect(DEFAULT_PORTS.oracle).toBe(1521);
    expect(effectivePort({ name: 'o', driver: 'oracle', host: 'h' })).toBe(1521);
    expect(effectivePort({ name: 'o', driver: 'oracle', host: 'h', port: 1522 })).toBe(1522);
  });

  it('needs a host like any network driver', () => {
    expect(connectionProblems({ name: 'o', driver: 'oracle', host: ' ' })).toContain('host-empty');
    expect(connectionProblems({ name: 'o', driver: 'oracle', host: 'h', port: 1521 })).toEqual([]);
  });

  it('honours timeouts, keep-alive and a time zone, but no charset and no TLS yet', () => {
    expect(optionSupport('oracle')).toEqual({
      connectTimeout: true,
      keepAlive: true,
      timeZone: true,
      charset: false,
      queryTimeout: true,
      tls: false,
    });
  });

  it('offers TLS to every network driver except Oracle, and never for files', () => {
    for (const driver of DRIVER_IDS) {
      expect(optionSupport(driver).tls, driver).toBe(driver !== 'oracle' && !isFileDriver(driver));
    }
  });

  it('filters schemas only: the database is the service it connects to', () => {
    expect(filterSupport('oracle')).toEqual({ databases: false, schemas: true });
  });
});

describe('Redis connections (V7.1)', () => {
  const redis = { name: 'Cache', driver: 'redis', host: 'h' } as const;

  it('is a driver of its own family, apart from SQL', () => {
    expect(isDriverId('redis')).toBe(true);
    expect(driverFamily('redis')).toBe('redis');
    expect(isSqlDriver('redis')).toBe(false);
    for (const id of SQL_DRIVER_IDS) {
      expect(driverFamily(id)).toBe('sql');
      expect(isSqlDriver(id)).toBe(true);
    }
    expect([...SQL_DRIVER_IDS, 'redis'].sort()).toEqual([...DRIVER_IDS].sort());
    expect(isFileDriver('redis')).toBe(false);
  });

  it('defaults to one server on port 6379, and Sentinels on 26379', () => {
    expect(DEFAULT_PORTS.redis).toBe(6379);
    expect(redisModeOf({ redis: undefined })).toBe('standalone');
    expect(effectivePort(redis)).toBe(6379);
    expect(effectivePort({ ...redis, redis: { mode: 'sentinel', masterName: 'm' } })).toBe(26_379);
    expect(effectivePort({ ...redis, redis: { mode: 'cluster' } })).toBe(6379);
    expect(effectivePort({ ...redis, port: 7000, redis: { mode: 'sentinel' } })).toBe(7000);
  });

  it('offers connect timeout, keep-alive and TLS, but no query timeout, time zone or charset', () => {
    expect(optionSupport('redis')).toEqual({
      connectTimeout: true,
      keepAlive: true,
      timeZone: false,
      charset: false,
      tls: true,
      queryTimeout: false,
    });
    expect(filterSupport('redis')).toEqual({ databases: false, schemas: false });
  });

  it('accepts one server, a Sentinel group and a cluster', () => {
    expect(connectionProblems(redis)).toEqual([]);
    expect(connectionProblems({ ...redis, database: '15' })).toEqual([]);
    expect(
      connectionProblems({
        ...redis,
        redis: { mode: 'sentinel', masterName: 'm', nodes: [{ host: 's2' }] },
      }),
    ).toEqual([]);
    expect(connectionProblems({ ...redis, database: '0', redis: { mode: 'cluster' } })).toEqual([]);
  });

  it('wants a database number', () => {
    for (const database of ['one', '-1', '1.5', '123456']) {
      expect(redisProblems({ ...redis, database }), database).toEqual(['redis-database-invalid']);
    }
    expect(redisProblems({ ...redis, database: ' 3 ' })).toEqual([]);
  });

  it('allows only database 0 in a cluster', () => {
    expect(redisProblems({ ...redis, database: '2', redis: { mode: 'cluster' } })).toEqual([
      'redis-cluster-database',
    ]);
  });

  it('wants the master name in Sentinel mode', () => {
    expect(redisProblems({ ...redis, redis: { mode: 'sentinel', masterName: '  ' } })).toEqual([
      'redis-master-empty',
    ]);
  });

  it('checks the extra nodes and how many there are', () => {
    expect(redisProblems({ ...redis, redis: { mode: 'cluster', nodes: [{ host: '' }] } })).toEqual([
      'redis-node-invalid',
    ]);
    expect(
      redisProblems({ ...redis, redis: { mode: 'cluster', nodes: [{ host: 'a', port: 0 }] } }),
    ).toEqual(['redis-node-invalid']);
    const many = Array.from({ length: MAX_REDIS_NODES + 1 }, () => ({ host: 'n' }));
    expect(redisProblems({ ...redis, redis: { mode: 'cluster', nodes: many } })).toEqual([
      'redis-too-many-nodes',
    ]);
  });

  it('allows SSH only to one server', () => {
    const ssh = { id: 'h', host: 'b', user: 'u', auth: 'agent' } as const;
    expect(redisProblems({ ...redis, ssh })).toEqual([]);
    expect(redisProblems({ ...redis, ssh, redis: { mode: 'cluster' } })).toEqual([
      'redis-ssh-topology',
    ]);
    expect(
      connectionProblems({ ...redis, ssh, redis: { mode: 'sentinel', masterName: 'm' } }),
    ).toContain('redis-ssh-topology');
  });

  it('has nothing to say about other drivers', () => {
    expect(
      redisProblems({
        name: 'x',
        driver: 'mysql',
        host: 'h',
        database: 'shop',
        redis: { mode: 'sentinel' },
      }),
    ).toEqual([]);
  });

  it('describes the target with the default port', () => {
    expect(describeTarget({ ...redis, user: 'app' })).toBe('app@h:6379');
  });
});
