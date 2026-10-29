import { describe, expect, it } from 'vitest';
import { parseConnectionUrl, urlDriver } from '../../../src/shared/connection-url';
import { isMongoUrl, parseMongoUrl } from '../../../src/shared/mongo-url';

function parsed(text: string) {
  const result = parseMongoUrl(text);
  if (!result.ok) {
    throw new Error(result.problem);
  }
  return result.value;
}

describe('parseMongoUrl (V7.5)', () => {
  it('reads one server with its database, user and password apart', () => {
    expect(parsed('mongodb://app:s3cr%40t@db.example.com:7017/shop')).toEqual({
      input: {
        name: 'shop',
        driver: 'mongodb',
        host: 'db.example.com',
        port: 7017,
        user: 'app',
        database: 'shop',
      },
      password: 's3cr@t',
    });
  });

  it('reads a seed list as a replica set, its name and the other members', () => {
    const { input } = parsed('mongodb://a:27017,b,[::1]:27019/?replicaSet=rs0&authSource=admin');
    expect(input).toMatchObject({
      name: 'a',
      host: 'a',
      port: 27_017,
      mongo: {
        mode: 'replicaSet',
        replicaSet: 'rs0',
        nodes: [{ host: 'b' }, { host: '::1', port: 27_019 }],
        authSource: 'admin',
      },
    });
  });

  it('takes one host with replicaSet as a set, unless directConnection says otherwise', () => {
    expect(parsed('mongodb://a/?replicaSet=rs0').input.mongo).toEqual({
      mode: 'replicaSet',
      replicaSet: 'rs0',
    });
    expect(parsed('mongodb://a/?replicaSet=rs0&directConnection=true').input.mongo).toBeUndefined();
    expect(parsed('mongodb://a,b/?directConnection=true').input.mongo).toBeUndefined();
  });

  it('reads SRV as TLS with a checked certificate and no port', () => {
    const { input, password } = parsed(
      'mongodb+srv://u:p@cluster0.abcde.mongodb.net/logs?retryWrites=true&w=majority',
    );
    expect(input).toEqual({
      name: 'logs',
      driver: 'mongodb',
      host: 'cluster0.abcde.mongodb.net',
      user: 'u',
      database: 'logs',
      ssl: { mode: 'verify-full' },
      mongo: { mode: 'srv' },
    });
    expect(password).toBe('p');
    expect(parsed('mongodb+srv://c.x.net/?tls=false').input.ssl).toBeUndefined();
  });

  it('reads the TLS options of the URL', () => {
    expect(parsed('mongodb://h/?tls=true').input.ssl).toEqual({ mode: 'verify-full' });
    expect(parsed('mongodb://h/?ssl=true&tlsInsecure=true').input.ssl).toEqual({ mode: 'require' });
    expect(parsed('mongodb://h/?tls=true&tlsAllowInvalidCertificates=true').input.ssl?.mode).toBe(
      'require',
    );
    expect(parsed('mongodb://h/?tls=true&tlsAllowInvalidHostnames=true').input.ssl?.mode).toBe(
      'verify-ca',
    );
    expect(
      parsed('mongodb://h/?tls=true&tlsCAFile=%2Fetc%2Fca.pem&tlsCertificateKeyFile=/c/me.pem')
        .input.ssl,
    ).toEqual({ mode: 'verify-full', ca: '/etc/ca.pem', cert: '/c/me.pem', key: '/c/me.pem' });
    expect(parsed('mongodb://h/?TLS=TRUE').input.ssl?.mode).toBe('verify-full');
  });

  it('reads the sign-in mechanism it knows and ignores others', () => {
    expect(parsed('mongodb://h/?authMechanism=MONGODB-X509').input.mongo).toEqual({
      mode: 'direct',
      authMechanism: 'MONGODB-X509',
    });
    expect(parsed('mongodb://h/?authMechanism=scram-sha-1').input.mongo?.authMechanism).toBe(
      'SCRAM-SHA-1',
    );
    expect(parsed('mongodb://h/?authMechanism=GSSAPI').input.mongo).toBeUndefined();
  });

  it('keeps an @ in the password and names the connection after the host without a database', () => {
    const { input, password } = parsed('mongodb://u:a@b@host');
    expect(input).toMatchObject({ host: 'host', user: 'u', name: 'host' });
    expect(password).toBe('a@b');
    expect(parsed('mongodb://u@host').password).toBeUndefined();
  });

  it('refuses what is not a MongoDB URL or names no host', () => {
    expect(parseMongoUrl('mysql://h')).toEqual({ ok: false, problem: 'not-a-url' });
    expect(parseMongoUrl('mongodb://')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseMongoUrl('mongodb://a,,b:99999')).toEqual({ ok: false, problem: 'not-a-url' });
    expect(parseMongoUrl('mongodb://u:p@/db')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseMongoUrl('mongodb://h:abc')).toEqual({ ok: false, problem: 'not-a-url' });
  });

  it('is what the general URL parser uses for mongodb schemes', () => {
    expect(urlDriver('mongodb+srv://x')).toBe('mongodb');
    expect(isMongoUrl(' mongodb://h')).toBe(true);
    expect(isMongoUrl('mongo://h')).toBe(false);
    const result = parseConnectionUrl('mongodb://a,b/?replicaSet=rs0');
    expect(result.ok && result.value.input.mongo?.mode).toBe('replicaSet');
  });
});
