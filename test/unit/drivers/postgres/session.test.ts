import type { PeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import type { TlsMaterial } from '../../../../src/drivers/common/tls';
import { clientConfig, postgresSsl } from '../../../../src/drivers/postgres/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';

const config: ResolvedConnectionConfig = {
  id: 'c',
  name: 'n',
  driver: 'postgres',
  host: 'db.example',
  user: 'app',
};

type SslObject = Exclude<ReturnType<typeof postgresSsl>, boolean | undefined>;

function ssl(material: TlsMaterial): SslObject {
  const value = postgresSsl(material);
  if (typeof value !== 'object') {
    throw new Error('expected TLS options');
  }
  return value;
}

describe('postgresSsl', () => {
  it('encrypts without checks in require', () => {
    const options = ssl({ mode: 'require', serverName: 'db.example' });
    expect(options.rejectUnauthorized).toBe(false);
    expect(options.checkServerIdentity?.('x', {} as PeerCertificate)).toBeUndefined();
  });

  it('sends SNI for host names only', () => {
    expect(ssl({ mode: 'verify-ca', serverName: 'db.example' }).servername).toBe('db.example');
    expect(ssl({ mode: 'verify-ca', serverName: '10.0.0.5' })).not.toHaveProperty('servername');
  });

  it('checks the real name in verify-full', () => {
    const options = ssl({ mode: 'verify-full', serverName: 'db.example', ca: Buffer.from('CA') });
    const cert = { subject: { CN: 'db.example' }, subjectaltname: 'DNS:db.example' };
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ca).toEqual(Buffer.from('CA'));
    expect(options.checkServerIdentity?.('127.0.0.1', cert as PeerCertificate)).toBeUndefined();
    const other = { subject: { CN: 'evil' }, subjectaltname: 'DNS:evil.example' };
    expect(options.checkServerIdentity?.('db.example', other as PeerCertificate)).toBeInstanceOf(
      Error,
    );
  });
});

describe('clientConfig', () => {
  it('has no TLS unless asked for, and defaults the database', () => {
    const options = clientConfig(config, undefined);
    expect(options).not.toHaveProperty('ssl');
    expect(options.database).toBe('postgres');
  });

  it('adds the TLS options', () => {
    expect(clientConfig(config, { mode: 'require', serverName: 'db.example' }).ssl).toMatchObject({
      rejectUnauthorized: false,
    });
  });
});

describe('clientConfig: session options (V4.9)', () => {
  it('waits 10 s by default and keeps TCP alive', () => {
    expect(clientConfig(config, undefined)).toMatchObject({
      connectionTimeoutMillis: 10_000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 30_000,
    });
  });

  it('takes the connect timeout from the connection', () => {
    expect(
      clientConfig({ ...config, options: { connectTimeout: 45 } }, undefined)
        .connectionTimeoutMillis,
    ).toBe(45_000);
  });
});
