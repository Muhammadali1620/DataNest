import { describe, expect, it } from 'vitest';
import {
  parseConnectionUrl,
  suggestedName,
  urlDriver,
  type UrlResult,
} from '../../../src/shared/connection-url';

function ok(result: UrlResult) {
  if (!result.ok) {
    throw new Error(`expected a parsed URL, got ${result.problem}`);
  }
  return result.value;
}

describe('urlDriver', () => {
  it('knows the schemes frameworks print, with jdbc: and +driver prefixes', () => {
    expect(urlDriver('mysql://h')).toBe('mysql');
    expect(urlDriver('mariadb://h')).toBe('mysql');
    expect(urlDriver('mysql+pymysql://h')).toBe('mysql');
    expect(urlDriver('postgres://h')).toBe('postgres');
    expect(urlDriver('postgresql+asyncpg://h')).toBe('postgres');
    expect(urlDriver('jdbc:postgresql://h')).toBe('postgres');
    expect(urlDriver('PGSQL://h')).toBe('postgres');
    expect(urlDriver('sqlite:///x')).toBe('sqlite');
    expect(urlDriver('file:./dev.db')).toBe('sqlite');
  });

  it('ignores everything else', () => {
    expect(urlDriver('redis://h')).toBeUndefined();
    expect(urlDriver('https://example.com')).toBeUndefined();
    expect(urlDriver('just text')).toBeUndefined();
  });
});

describe('parseConnectionUrl', () => {
  it('reads every part of a PostgreSQL URL, decoding escapes', () => {
    expect(
      ok(parseConnectionUrl('  postgres://us%40er:p%40ss%3A@db.example.com:6543/app%20db  ')),
    ).toEqual({
      input: {
        name: 'app db',
        driver: 'postgres',
        host: 'db.example.com',
        port: 6543,
        user: 'us@er',
        database: 'app db',
      },
      password: 'p@ss:',
    });
  });

  it('keeps the password out of the input', () => {
    const value = ok(parseConnectionUrl('mysql://root:secret@localhost/shop'));
    expect(JSON.stringify(value.input)).not.toContain('secret');
    expect(value.password).toBe('secret');
  });

  it('takes an unescaped @ in the password, up to the last one', () => {
    expect(ok(parseConnectionUrl('mysql://u:p@ss@h/d')).password).toBe('p@ss');
  });

  it('leaves out what the URL does not say', () => {
    expect(ok(parseConnectionUrl('mariadb://localhost'))).toEqual({
      input: { name: 'localhost', driver: 'mysql', host: 'localhost' },
    });
  });

  it('reads IPv6 hosts and query parameters for host, port, user and database', () => {
    expect(ok(parseConnectionUrl('mysql://[::1]:3307/x')).input).toMatchObject({
      host: '::1',
      port: 3307,
    });
    expect(
      ok(
        parseConnectionUrl(
          'postgres:///?host=/var/run/postgresql&port=5433&user=me&dbname=app&password=pw',
        ),
      ),
    ).toEqual({
      input: {
        name: 'app',
        driver: 'postgres',
        host: '/var/run/postgresql',
        port: 5433,
        user: 'me',
        database: 'app',
      },
      password: 'pw',
    });
  });

  it('refuses a port that is out of range', () => {
    expect(parseConnectionUrl('postgres://h:99999/d')).toEqual({ ok: false, problem: 'not-a-url' });
    expect(ok(parseConnectionUrl('postgres://h/d?port=99999')).input).not.toHaveProperty('port');
  });

  it.each([
    ['postgres://h/d?sslmode=require', { mode: 'require' }],
    [
      'postgres://h/d?sslmode=verify-full&sslrootcert=/ca.pem',
      { mode: 'verify-full', ca: '/ca.pem' },
    ],
    [
      'postgres://h/d?sslmode=verify-ca&sslcert=%2Fc.crt&sslkey=/c.key',
      { mode: 'verify-ca', cert: '/c.crt', key: '/c.key' },
    ],
    ['mysql://h/d?ssl-mode=VERIFY_IDENTITY&ssl-ca=/ca', { mode: 'verify-full', ca: '/ca' }],
    ['mysql://h/d?sslMode=REQUIRED', { mode: 'require' }],
    ['jdbc:mysql://h/d?useSSL=true', { mode: 'require' }],
    ['postgres://h/d?ssl=true', { mode: 'require' }],
    ['mysql://h/d?ssl={"rejectUnauthorized":true}', { mode: 'verify-full' }],
    ['mysql://h/d?ssl={"rejectUnauthorized":false}', { mode: 'require' }],
  ])('maps the TLS settings of %s', (url, ssl) => {
    expect(ok(parseConnectionUrl(url)).input.ssl).toEqual(ssl);
  });

  it.each([
    'postgres://h/d?sslmode=disable',
    'postgres://h/d?sslmode=prefer',
    'mysql://h/d?ssl-mode=PREFERRED',
    'postgres://h/d?ssl=false',
    'postgres://h/d?sslmode=unknown',
  ])('uses no TLS for %s', (url) => {
    expect(ok(parseConnectionUrl(url)).input).not.toHaveProperty('ssl');
  });

  it.each([
    ['sqlite:///home/me/app.db', '/home/me/app.db', 'app.db'],
    ['sqlite:app.db', 'app.db', 'app.db'],
    ['file:./dev.db', './dev.db', 'dev.db'],
    ['sqlite:///C:/data/x.db', 'C:/data/x.db', 'x.db'],
    ['sqlite:///my%20db.sqlite?mode=ro', '/my db.sqlite', 'my db.sqlite'],
  ])('reads the SQLite file of %s', (url, file, name) => {
    expect(ok(parseConnectionUrl(url))).toEqual({ input: { name, driver: 'sqlite', file } });
  });

  it('says what is wrong with a URL it cannot use', () => {
    expect(parseConnectionUrl('localhost:5432')).toEqual({ ok: false, problem: 'unknown-scheme' });
    expect(parseConnectionUrl('just text')).toEqual({ ok: false, problem: 'not-a-url' });
    expect(parseConnectionUrl('')).toEqual({ ok: false, problem: 'not-a-url' });
    expect(parseConnectionUrl('redis://cache:6379')).toEqual({
      ok: false,
      problem: 'unknown-scheme',
    });
    expect(parseConnectionUrl('postgres://')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseConnectionUrl('postgres:///db')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseConnectionUrl('sqlite://')).toEqual({ ok: false, problem: 'no-file' });
    expect(parseConnectionUrl('mysql://a b/c')).toEqual({ ok: false, problem: 'not-a-url' });
  });

  it('keeps a stray percent sign as it is', () => {
    expect(ok(parseConnectionUrl('mysql://u:100%@h/d')).password).toBe('100%');
  });
});

describe('suggestedName', () => {
  it('prefers the database, then the host, then the file name', () => {
    expect(suggestedName({ name: '', driver: 'mysql', host: 'h', database: 'shop' })).toBe('shop');
    expect(suggestedName({ name: '', driver: 'mysql', host: 'h' })).toBe('h');
    expect(suggestedName({ name: '', driver: 'mysql' })).toBe('mysql');
    expect(suggestedName({ name: '', driver: 'sqlite', file: 'C:\\db\\a.db' })).toBe('a.db');
    expect(suggestedName({ name: '', driver: 'sqlite' })).toBe('');
  });
});
