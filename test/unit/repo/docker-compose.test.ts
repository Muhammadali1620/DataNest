import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { utils } from 'ssh2';
import {
  DEFAULT_PORTS,
  DEFAULT_SSH_PORT,
  type TestDatabaseId,
  testSshServer,
} from '../../helpers/databases';
import { ROOT } from '../../helpers/repo';

interface Service {
  image: string;
  build?: string;
  container_name: string;
  ports: string[];
  volumes?: string[];
  tmpfs?: string[];
  healthcheck?: { test: string[] };
}

const compose = parse(readFileSync(join(ROOT, 'docker/compose.yml'), 'utf8')) as {
  name: string;
  services: Record<string, Service>;
};
const all = Object.entries(compose.services);
/** The databases; the SSH server has its own rules below. */
const services = all.filter(([id]) => id in DEFAULT_PORTS);

function parsePort(mapping: string): { host: string; hostPort: number; containerPort: number } {
  const match = /^(\d+\.\d+\.\d+\.\d+):(\d+):(\d+)$/.exec(mapping);
  if (!match) {
    throw new Error(`Port mapping "${mapping}" must look like 127.0.0.1:7xxx:port`);
  }
  return { host: match[1] ?? '', hostPort: Number(match[2]), containerPort: Number(match[3]) };
}

describe('docker/compose.yml (D17)', () => {
  it('uses its own compose project, so commands never touch other containers', () => {
    expect(compose.name).toBe('datanest');
  });

  it('provides MySQL, MariaDB, PostgreSQL and an SSH server', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['mariadb', 'mysql', 'postgres', 'ssh']);
  });

  it.each(all)('names the %s container with the datanest- prefix', (id, service) => {
    expect(service.container_name).toBe(`datanest-${id}`);
  });

  it.each(all)('publishes %s only on 127.0.0.1 within ports 7000-7999', (_id, service) => {
    expect(service.ports.length).toBeGreaterThan(0);
    for (const mapping of service.ports) {
      const { host, hostPort } = parsePort(mapping);
      expect(host).toBe('127.0.0.1');
      expect(hostPort).toBeGreaterThanOrEqual(7000);
      expect(hostPort).toBeLessThanOrEqual(7999);
    }
  });

  it('publishes the ports the tests connect to', () => {
    for (const [id, service] of services) {
      const [first] = service.ports;
      expect(parsePort(first ?? '').hostPort).toBe(DEFAULT_PORTS[id as TestDatabaseId]);
    }
  });

  it('never publishes the same host port twice', () => {
    const ports = all.flatMap(([, s]) => s.ports.map((p) => parsePort(p).hostPort));
    expect(new Set(ports).size).toBe(ports.length);
  });

  it.each(services)('pins the %s image to a version', (_id, service) => {
    expect(service.image).toMatch(/^[a-z]+:\d+(\.\d+)*(-[a-z]+)?$/);
    expect(service.image).not.toContain(':latest');
  });

  it.each(services)('waits for the %s seed with a healthcheck', (_id, service) => {
    expect(service.healthcheck?.test.join(' ')).toContain('big_table');
  });

  it.each(services)('keeps %s data in tmpfs so every start is clean', (_id, service) => {
    expect(service.tmpfs?.length).toBeGreaterThan(0);
  });

  it.each(services)('mounts an existing seed folder into %s read-only', (_id, service) => {
    const seeds = (service.volumes ?? []).filter((v) => v.includes('docker-entrypoint-initdb.d'));
    expect(seeds).toHaveLength(1);
    const [source = '', , mode] = (seeds[0] ?? '').split(':');
    expect(mode).toBe('ro');
    expect(existsSync(join(ROOT, 'docker', source))).toBe(true);
  });

  describe('ssh', () => {
    const ssh = compose.services.ssh;

    it('is built from docker/ssh under our own image name', () => {
      expect(ssh?.build).toBe('./ssh');
      expect(ssh?.image).toMatch(/^datanest-ssh:\d+$/);
      expect(existsSync(join(ROOT, 'docker/ssh/Dockerfile'))).toBe(true);
    });

    it('publishes the port the tunnel tests use', () => {
      expect(parsePort(ssh?.ports[0] ?? '')).toEqual({
        host: '127.0.0.1',
        hostPort: DEFAULT_SSH_PORT,
        containerPort: 22,
      });
    });

    it('pins the base image and allows TCP forwarding', () => {
      const dockerfile = readFileSync(join(ROOT, 'docker/ssh/Dockerfile'), 'utf8');
      expect(dockerfile).toMatch(/^FROM alpine:\d+\.\d+$/m);
      const config = readFileSync(join(ROOT, 'docker/ssh/sshd_config'), 'utf8');
      expect(config).toMatch(/^AllowTcpForwarding yes$/m);
      expect(config).toMatch(/^PermitRootLogin no$/m);
    });

    it('accepts exactly the key the tests log in with', () => {
      const authorized = readFileSync(join(ROOT, 'docker/ssh/authorized_keys'), 'utf8').trim();
      const key = utils.parseKey(
        readFileSync(join(ROOT, 'test/fixtures/ssh/id_ed25519')),
        testSshServer({}).passphrase,
      );
      if (key instanceof Error || Array.isArray(key)) {
        throw new Error('the fixture key must parse with its passphrase');
      }
      const [type, blob] = authorized.split(' ');
      expect(type).toBe(key.type);
      expect(blob).toBe(key.getPublicSSH().toString('base64'));
    });
  });
});
