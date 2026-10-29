import { describe, expect, it } from 'vitest';
import { authSourceOf, mongoOptions, mongoUrl } from '../../../../src/drivers/mongodb/options';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';

function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return { id: 'c', name: 'c', driver: 'mongodb', host: 'db.example.com', ...overrides };
}

describe('mongoUrl (V7.5)', () => {
  it('names one server, with the default port', () => {
    expect(mongoUrl(config())).toBe('mongodb://db.example.com:27017/');
    expect(mongoUrl(config({ port: 7017 }))).toBe('mongodb://db.example.com:7017/');
  });

  it('ignores other members unless it is a replica set', () => {
    expect(mongoUrl(config({ mongo: { mode: 'direct', nodes: [{ host: 'b' }] } }))).toBe(
      'mongodb://db.example.com:27017/',
    );
    expect(
      mongoUrl(
        config({ mongo: { mode: 'replicaSet', nodes: [{ host: 'b' }, { host: 'c', port: 7 }] } }),
      ),
    ).toBe('mongodb://db.example.com:27017,b:27017,c:7/');
  });

  it('writes an SRV record without a port, and IPv6 addresses in brackets', () => {
    expect(mongoUrl(config({ host: 'cluster0.x.net', port: 1, mongo: { mode: 'srv' } }))).toBe(
      'mongodb+srv://cluster0.x.net/',
    );
    expect(mongoUrl(config({ host: '::1' }))).toBe('mongodb://[::1]:27017/');
  });
});

describe('authSourceOf (V7.5)', () => {
  it('takes the setting, else $external for X.509, else the database, else admin', () => {
    expect(authSourceOf(config({ mongo: { mode: 'direct', authSource: ' users ' } }))).toBe(
      'users',
    );
    expect(authSourceOf(config({ mongo: { mode: 'direct', authMechanism: 'MONGODB-X509' } }))).toBe(
      '$external',
    );
    expect(authSourceOf(config({ database: 'shop' }))).toBe('shop');
    expect(authSourceOf(config({ database: ' ' }))).toBe('admin');
  });
});

describe('mongoOptions (V7.5)', () => {
  it('talks to one server only in direct mode, and names the set in replica set mode', () => {
    expect(mongoOptions(config(), undefined).directConnection).toBe(true);
    const set = mongoOptions(
      config({ mongo: { mode: 'replicaSet', replicaSet: 'rs0' } }),
      undefined,
    );
    expect(set.directConnection).toBeUndefined();
    expect(set.replicaSet).toBe('rs0');
    expect(
      mongoOptions(config({ mongo: { mode: 'replicaSet', replicaSet: ' ' } }), undefined)
        .replicaSet,
    ).toBeUndefined();
  });

  it('signs in with the user and password in the options, never in the URL', () => {
    const options = mongoOptions(config({ user: 'app', password: 'p@ss:/' }), undefined);
    expect(options.auth).toEqual({ username: 'app', password: 'p@ss:/' });
    expect(options.authSource).toBe('admin');
    expect(options.authMechanism).toBeUndefined();
    expect(mongoUrl(config({ user: 'app', password: 'p@ss:/' }))).not.toContain('app');
  });

  it('does not sign in without a user, unless with a certificate', () => {
    const anonymous = mongoOptions(config(), undefined);
    expect(anonymous.auth).toBeUndefined();
    expect(anonymous.authSource).toBeUndefined();
    const x509 = mongoOptions(
      config({ mongo: { mode: 'direct', authMechanism: 'MONGODB-X509' } }),
      undefined,
    );
    expect(x509.auth).toBeUndefined();
    expect(x509.authMechanism).toBe('MONGODB-X509');
    expect(x509.authSource).toBe('$external');
  });

  it('waits as long as the connection says, 10 seconds by default', () => {
    expect(mongoOptions(config(), undefined).serverSelectionTimeoutMS).toBe(10_000);
    const options = mongoOptions(config({ options: { connectTimeout: 3 } }), undefined);
    expect(options.serverSelectionTimeoutMS).toBe(3000);
    expect(options.connectTimeoutMS).toBe(3000);
  });

  it('turns TLS off unless asked, and leaves SRV to its default (TLS)', () => {
    expect(mongoOptions(config(), undefined).tls).toBe(false);
    expect(mongoOptions(config({ mongo: { mode: 'srv' } }), undefined).tls).toBeUndefined();
  });

  it('checks the certificate as the mode says, against the real server name', () => {
    const ca = Buffer.from('ca');
    const full = mongoOptions(config(), { mode: 'verify-full', ca, serverName: 'db.example.com' });
    expect(full).toMatchObject({
      tls: true,
      ca,
      rejectUnauthorized: true,
      servername: 'db.example.com',
    });
    expect(full.checkServerIdentity).toBeTypeOf('function');
    expect(full).not.toHaveProperty('tlsAllowInvalidHostnames');
    const loose = mongoOptions(config(), { mode: 'require', serverName: '10.0.0.1' });
    expect(loose.rejectUnauthorized).toBe(false);
    // SNI cannot carry an IP address.
    expect(loose.servername).toBeUndefined();
    const client = mongoOptions(config(), {
      mode: 'verify-ca',
      cert: Buffer.from('c'),
      key: Buffer.from('k'),
      serverName: 'x',
    });
    expect(client.cert).toEqual(Buffer.from('c'));
    expect(client.key).toEqual(Buffer.from('k'));
  });
});
