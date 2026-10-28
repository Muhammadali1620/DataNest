import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { ROOT } from '../../helpers/repo';

// The test CA in docker/tls is what the TLS integration tests rely on; a cert that
// expired or lost a name would break them in a way that looks like a code bug.
const dir = join(ROOT, 'docker', 'tls');
const cert = (name: string) => new X509Certificate(readFileSync(join(dir, name)));

describe('test certificates (docker/tls)', () => {
  const ca = cert('ca.crt');
  const server = cert('server.crt');
  const client = cert('client.crt');

  it('has a CA that issued both the server and the client certificate', () => {
    expect(ca.ca).toBe(true);
    expect(server.checkIssued(ca)).toBe(true);
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(client.checkIssued(ca)).toBe(true);
    expect(server.checkIssued(cert('other-ca.crt'))).toBe(false);
  });

  it('covers the names the tests connect by, and not the aliases', () => {
    for (const host of ['localhost', 'mysql', 'postgres']) {
      expect(server.checkHost(host)).toBe(host);
    }
    expect(server.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(server.checkHost('postgres-alias')).toBeUndefined();
    expect(server.checkHost('mysql-alias')).toBeUndefined();
  });

  it('names the client after the PostgreSQL role it logs in as', () => {
    expect(client.subject).toContain('CN=datanest_cert');
  });

  it('stays valid for decades', () => {
    const in50Years = Date.now() + 50 * 365 * 24 * 3600 * 1000;
    for (const each of [ca, server, client]) {
      expect(new Date(each.validTo).getTime()).toBeGreaterThan(in50Years);
    }
  });

  it('ships the keys that match the certificates, and no CA key', () => {
    const publicOf = (file: string) =>
      createPublicKey(createPrivateKey(readFileSync(join(dir, file))))
        .export({ type: 'spki', format: 'der' })
        .toString('base64');
    const exported = (each: X509Certificate) =>
      each.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    expect(publicOf('server.key')).toBe(exported(server));
    expect(publicOf('client.key')).toBe(exported(client));
    expect(() => readFileSync(join(dir, 'ca.key'))).toThrow();
  });

  it('is mounted into the database servers that the TLS tests use', () => {
    const compose = parse(readFileSync(join(ROOT, 'docker/compose.yml'), 'utf8')) as {
      services: Record<string, { volumes?: string[] }>;
    };
    for (const id of ['mysql', 'mariadb', 'postgres']) {
      expect(compose.services[id]?.volumes).toContain('./tls:/etc/datanest-tls:ro');
    }
  });
});
