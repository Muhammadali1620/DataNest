import { describe, expect, it } from 'vitest';
import {
  connectionProblems,
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
