import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DEFAULT_PORTS, type TestDatabaseId } from '../../helpers/databases';
import { ROOT } from '../../helpers/repo';

interface Service {
  image: string;
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
const services = Object.entries(compose.services);

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

  it('provides MySQL, MariaDB and PostgreSQL', () => {
    expect(Object.keys(compose.services).sort()).toEqual(['mariadb', 'mysql', 'postgres']);
  });

  it.each(services)('names the %s container with the datanest- prefix', (id, service) => {
    expect(service.container_name).toBe(`datanest-${id}`);
  });

  it.each(services)('publishes %s only on 127.0.0.1 within ports 7000-7999', (_id, service) => {
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
    const ports = services.flatMap(([, s]) => s.ports.map((p) => parsePort(p).hostPort));
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
});
