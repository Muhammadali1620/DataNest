import { describe, expect, it } from 'vitest';
import type { TlsMaterial } from '../../../../src/drivers/common/tls';
import {
  connectionConfig,
  loginFailure,
  splitInstance,
  verifyChain,
} from '../../../../src/drivers/mssql/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';

const config: ResolvedConnectionConfig = {
  id: 'c',
  name: 'n',
  driver: 'mssql',
  host: 'db.example',
  user: 'app',
  password: 'secret',
  database: 'shop',
};

const material = (mode: TlsMaterial['mode'], extra: Partial<TlsMaterial> = {}): TlsMaterial => ({
  mode,
  serverName: 'db.example',
  ...extra,
});

describe('splitInstance', () => {
  it('splits a named instance off the host', () => {
    expect(splitInstance('db\\SQLEXPRESS')).toEqual({ server: 'db', instance: 'SQLEXPRESS' });
    expect(splitInstance('db.example')).toEqual({ server: 'db.example' });
    expect(splitInstance('db\\')).toEqual({ server: 'db', instance: '' });
  });
});

describe('connectionConfig', () => {
  it('connects to the default port with a SQL login and the database', () => {
    const result = connectionConfig(config, undefined);
    expect(result.server).toBe('db.example');
    expect(result.authentication).toEqual({
      type: 'default',
      options: { userName: 'app', password: 'secret' },
    });
    expect(result.options).toMatchObject({
      port: 1433,
      database: 'shop',
      encrypt: false,
      trustServerCertificate: true,
      requestTimeout: 0,
      useUTC: true,
      useColumnNames: false,
      rowCollectionOnDone: false,
      rowCollectionOnRequestCompletion: false,
      maxRetriesOnTransientErrors: 0,
      connectTimeout: 10_000,
      appName: 'DataNest',
    });
    expect(result.options).not.toHaveProperty('serverName');
  });

  it('uses the given port and connect timeout, and leaves out an empty database', () => {
    const result = connectionConfig(
      { ...config, port: 7143, database: '', options: { connectTimeout: 3 } },
      undefined,
    );
    expect(result.options).toMatchObject({ port: 7143, connectTimeout: 3000 });
    expect(result.options).not.toHaveProperty('database');
  });

  it('asks the browser service for a named instance unless a port is given', () => {
    expect(
      connectionConfig({ ...config, host: 'db\\SQLEXPRESS' }, undefined).options,
    ).toMatchObject({
      instanceName: 'SQLEXPRESS',
    });
    const withPort = connectionConfig({ ...config, host: 'db\\SQLEXPRESS', port: 1500 }, undefined);
    expect(withPort.server).toBe('db');
    expect(withPort.options).toMatchObject({ port: 1500 });
    expect(withPort.options).not.toHaveProperty('instanceName');
  });

  it('falls back to localhost and empty credentials', () => {
    const { host: _host, user: _user, password: _password, ...bare } = config;
    const result = connectionConfig(bare, undefined);
    expect(result.server).toBe('localhost');
    expect(result.authentication).toEqual({
      type: 'default',
      options: { userName: '', password: '' },
    });
  });

  it('encrypts and trusts any certificate in require and verify-ca, checks it in verify-full', () => {
    expect(connectionConfig(config, material('require')).options).toMatchObject({
      encrypt: true,
      trustServerCertificate: true,
      serverName: 'db.example',
    });
    expect(connectionConfig(config, material('verify-ca')).options).toMatchObject({
      trustServerCertificate: true,
    });
    expect(connectionConfig(config, material('verify-full')).options).toMatchObject({
      encrypt: true,
      trustServerCertificate: false,
    });
  });

  it('hands the certificate files to the TLS context', () => {
    const ca = Buffer.from('CA');
    const cert = Buffer.from('CERT');
    const key = Buffer.from('KEY');
    expect(
      connectionConfig(config, material('verify-full', { ca, cert, key })).options
        ?.cryptoCredentialsDetails,
    ).toEqual({ ca, cert, key });
    expect(connectionConfig(config, material('require')).options?.cryptoCredentialsDetails).toEqual(
      {},
    );
  });

  it('checks the certificate against the server name, not the tunnel port', () => {
    const tunnelled = connectionConfig(
      { ...config, host: '127.0.0.1', port: 40000 },
      material('verify-full', { serverName: 'db.example' }),
    );
    expect(tunnelled.server).toBe('127.0.0.1');
    expect(tunnelled.options).toMatchObject({ serverName: 'db.example', port: 40000 });
  });
});

describe('verifyChain', () => {
  const connection = (cleartext: unknown) => ({ messageIo: { securePair: { cleartext } } });

  it('checks nothing outside verify-ca', () => {
    expect(() => {
      verifyChain({}, undefined);
    }).not.toThrow();
    expect(() => {
      verifyChain({}, material('require'));
    }).not.toThrow();
    expect(() => {
      verifyChain({}, material('verify-full'));
    }).not.toThrow();
  });

  it('accepts a trusted chain, even when the name does not match', () => {
    expect(() => {
      verifyChain(connection({ authorized: true }), material('verify-ca'));
    }).not.toThrow();
    expect(() => {
      verifyChain(
        connection({ authorized: false, authorizationError: 'ERR_TLS_CERT_ALTNAME_INVALID' }),
        material('verify-ca'),
      );
    }).not.toThrow();
  });

  it('refuses a chain that does not lead to the trusted CA', () => {
    expect(() => {
      verifyChain(
        connection({ authorized: false, authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN' }),
        material('verify-ca'),
      );
    }).toThrow(/not trusted/u);
    expect(() => {
      verifyChain(
        connection({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }),
        material('verify-ca'),
      );
    }).toThrow(/not valid now/u);
  });

  it('refuses an odd error and a connection that was not encrypted', () => {
    expect(() => {
      verifyChain(
        connection({ authorized: false, authorizationError: 'SOMETHING' }),
        material('verify-ca'),
      );
    }).toThrow(expect.objectContaining({ code: 'connection-failed' }));
    expect(() => {
      verifyChain({}, material('verify-ca'));
    }).toThrow(/did not encrypt/u);
  });
});

describe('loginFailure', () => {
  it('turns the first server message of a login into an error with its number', () => {
    const error = loginFailure([
      { number: 4060, message: 'Cannot open database "x" requested by the login.' },
      { number: 18456, message: "Login failed for user 'app'." },
    ]);
    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({ number: 4060, code: 'ELOGIN' });
    expect(error?.message).toMatch(/Cannot open database/u);
  });

  it('gives nothing without a numbered message', () => {
    expect(loginFailure([])).toBeUndefined();
    expect(loginFailure([{ message: 'x' }])).toBeUndefined();
  });

  it('fills in a message the server left out', () => {
    expect(loginFailure([{ number: 18456 }])?.message).toBe('Login failed');
  });
});
