import { describe, expect, it } from 'vitest';
import type { TlsMaterial } from '../../../../src/drivers/common/tls';
import { connectionOptions, mysqlSsl } from '../../../../src/drivers/mysql/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';

const config: ResolvedConnectionConfig = {
  id: 'c',
  name: 'n',
  driver: 'mysql',
  host: 'db.example',
  port: 3306,
  user: 'app',
};

const tls = (mode: TlsMaterial['mode'], serverName = 'db.example'): TlsMaterial => ({
  mode,
  serverName,
  ca: Buffer.from('CA'),
});

describe('mysqlSsl', () => {
  it('encrypts without checks in require', () => {
    expect(mysqlSsl(tls('require'))).toMatchObject({
      rejectUnauthorized: false,
      verifyIdentity: false,
    });
  });

  it('checks the issuer in verify-ca and the name too in verify-full', () => {
    expect(mysqlSsl(tls('verify-ca'))).toMatchObject({
      rejectUnauthorized: true,
      verifyIdentity: false,
    });
    expect(mysqlSsl(tls('verify-full'))).toMatchObject({
      rejectUnauthorized: true,
      verifyIdentity: true,
    });
  });

  it('leaves the name of an IP address to the driver', () => {
    expect(mysqlSsl(tls('verify-full', '10.0.0.5')).verifyIdentity).toBe(false);
  });

  it('passes only the files it has', () => {
    const ssl = mysqlSsl({ mode: 'require', serverName: 'x', cert: Buffer.from('C') });
    expect(ssl).not.toHaveProperty('ca');
    expect(ssl).not.toHaveProperty('key');
    expect(ssl.cert).toEqual(Buffer.from('C'));
  });
});

describe('connectionOptions', () => {
  it('connects straight to the host without TLS by default', () => {
    const options = connectionOptions(config, undefined);
    expect(options).toMatchObject({ host: 'db.example', port: 3306 });
    expect(options).not.toHaveProperty('ssl');
    expect(options).not.toHaveProperty('stream');
  });

  it('keeps the real name for TLS and sends the socket to the tunnel port', () => {
    const options = connectionOptions(
      { ...config, host: '127.0.0.1', port: 40_000, tlsServerName: 'db.internal' },
      tls('verify-full', 'db.internal'),
    );
    expect(options.host).toBe('db.internal');
    expect(typeof options.stream).toBe('function');
    expect(options.ssl).toMatchObject({ verifyIdentity: true });
  });
});

describe('connectionOptions: session options (V4.9)', () => {
  it('waits 10 s by default, keeps TCP alive, and talks utf8mb4', () => {
    expect(connectionOptions(config, undefined)).toMatchObject({
      connectTimeout: 10_000,
      charset: 'utf8mb4',
      enableKeepAlive: true,
      keepAliveInitialDelay: 30_000,
    });
  });

  it('takes the connect timeout and the character set from the connection', () => {
    expect(
      connectionOptions(
        { ...config, options: { connectTimeout: 3, charset: 'latin1' } },
        undefined,
      ),
    ).toMatchObject({ connectTimeout: 3000, charset: 'latin1' });
  });
});

describe('connectionOptions with a Unix socket (V10.2.5)', () => {
  it('connects to the socket instead of host and port', () => {
    const options = connectionOptions(
      { ...config, socket: ' /run/mysqld/mysqld.sock ' },
      undefined,
    );
    expect(options.socketPath).toBe('/run/mysqld/mysqld.sock');
    expect(options.host).toBeUndefined();
    expect(options.port).toBeUndefined();
    expect(options.stream).toBeUndefined();
  });

  it('uses host and port without one', () => {
    const options = connectionOptions({ ...config, socket: '  ' }, undefined);
    expect(options.socketPath).toBeUndefined();
    expect(options).toMatchObject({ host: 'db.example', port: 3306 });
  });

  it('keeps geometry as bytes for the driver to read as WKT (V10.2.4)', () => {
    const { typeCast } = connectionOptions(config, undefined);
    expect(typeof typeCast).toBe('function');
    const cast = typeCast as (field: unknown, next: () => unknown) => unknown;
    expect(cast({ type: 'GEOMETRY', buffer: () => Buffer.from([1]) }, () => 'parsed')).toEqual(
      Buffer.from([1]),
    );
    expect(cast({ type: 'VAR_STRING', buffer: () => Buffer.from([1]) }, () => 'parsed')).toBe(
      'parsed',
    );
  });
});
