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
    expect(urlDriver('mongodb://h')).toBeUndefined();
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
    expect(parseConnectionUrl('mongodb://cache:27017')).toEqual({
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

describe('SQL Server URLs (V6.2)', () => {
  it('knows the mssql and sqlserver schemes, with jdbc: too', () => {
    expect(urlDriver('mssql://h')).toBe('mssql');
    expect(urlDriver('sqlserver://h')).toBe('mssql');
    expect(urlDriver('jdbc:sqlserver://h;databaseName=x')).toBe('mssql');
  });

  it('reads the URL form with user, password, port and database', () => {
    expect(ok(parseConnectionUrl('mssql://sa:p%40ss@db.example:1444/shop'))).toEqual({
      input: {
        name: 'shop',
        driver: 'mssql',
        host: 'db.example',
        port: 1444,
        user: 'sa',
        database: 'shop',
      },
      password: 'p@ss',
    });
  });

  it('reads the JDBC form with ;key=value properties, which win over URL parts', () => {
    const value = ok(
      parseConnectionUrl(
        'jdbc:sqlserver://db.example:1433;databaseName=shop;user=app;password=s3cret;encrypt=true;trustServerCertificate=true',
      ),
    );
    expect(value.input).toMatchObject({
      driver: 'mssql',
      host: 'db.example',
      port: 1433,
      user: 'app',
      database: 'shop',
      ssl: { mode: 'require' },
    });
    expect(value.password).toBe('s3cret');
  });

  it('reads the Prisma form and property names without case or spaces', () => {
    const value = ok(
      parseConnectionUrl('sqlserver://localhost;Initial Catalog=app;User ID=sa;PWD=x;Encrypt=True'),
    );
    expect(value.input).toMatchObject({
      host: 'localhost',
      user: 'sa',
      database: 'app',
      ssl: { mode: 'verify-full' },
    });
    expect(value.password).toBe('x');
  });

  it('keeps a named instance in the host, from the URL or the properties', () => {
    expect(ok(parseConnectionUrl('sqlserver://srv\\SQLEXPRESS;database=a')).input.host).toBe(
      'srv\\SQLEXPRESS',
    );
    expect(ok(parseConnectionUrl('sqlserver://srv;instanceName=TWO')).input.host).toBe('srv\\TWO');
  });

  it('turns encrypt into TLS modes, and nothing when it is off', () => {
    const mode = (url: string) => ok(parseConnectionUrl(url)).input.ssl?.mode;
    expect(mode('mssql://h/db?encrypt=true')).toBe('verify-full');
    expect(mode('mssql://h/db?encrypt=true&trustServerCertificate=true')).toBe('require');
    expect(mode('sqlserver://h;encrypt=strict')).toBe('verify-full');
    expect(mode('sqlserver://h;encrypt=false')).toBeUndefined();
    expect(mode('sqlserver://h')).toBeUndefined();
  });

  it('takes the port from a property and drops one out of range', () => {
    expect(ok(parseConnectionUrl('sqlserver://h;port=7143')).input.port).toBe(7143);
    expect(ok(parseConnectionUrl('sqlserver://h:70000')).input.port).toBeUndefined();
  });

  it('names the problem of a URL without a host', () => {
    expect(parseConnectionUrl('sqlserver://')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseConnectionUrl('sqlserver://;database=x')).toEqual({
      ok: false,
      problem: 'no-host',
    });
    expect(parseConnectionUrl('mssql://a:b@:1433/db')).toMatchObject({ ok: false });
  });
});

describe('ClickHouse URLs (V6.3)', () => {
  it('knows the clickhouse and ch schemes, with jdbc: too', () => {
    expect(urlDriver('clickhouse://h')).toBe('clickhouse');
    expect(urlDriver('ch://h')).toBe('clickhouse');
    expect(urlDriver('jdbc:clickhouse://h:8123/db')).toBe('clickhouse');
  });

  it('reads user, password, port and database', () => {
    expect(ok(parseConnectionUrl('clickhouse://reader:p%40ss@ch.example:8123/events'))).toEqual({
      input: {
        name: 'events',
        driver: 'clickhouse',
        host: 'ch.example',
        port: 8123,
        user: 'reader',
        database: 'events',
      },
      password: 'p@ss',
    });
  });

  it('turns secure=true into TLS', () => {
    expect(ok(parseConnectionUrl('clickhouse://ch.example:8443/db?secure=true')).input.ssl).toEqual(
      { mode: 'require' },
    );
    expect(ok(parseConnectionUrl('jdbc:clickhouse://ch.example/db')).input).toMatchObject({
      driver: 'clickhouse',
      host: 'ch.example',
      database: 'db',
    });
    expect(ok(parseConnectionUrl('ch://ch.example/db')).input.ssl).toBeUndefined();
  });

  it('needs a host', () => {
    expect(parseConnectionUrl('clickhouse:///db')).toEqual({ ok: false, problem: 'no-host' });
  });
});

describe('Oracle URLs (V6.4)', () => {
  it('knows the oracle scheme, with jdbc: and thin: too', () => {
    expect(urlDriver('oracle://h')).toBe('oracle');
    expect(urlDriver('ORACLE://h')).toBe('oracle');
    expect(urlDriver('oracle:thin:@h:1521:ORCL')).toBe('oracle');
    expect(urlDriver('jdbc:oracle:thin:@//h:1521/SVC')).toBe('oracle');
  });

  it('reads user, password, port and the service as the database', () => {
    expect(ok(parseConnectionUrl('oracle://scott:tiger@db.example:1521/ORCLPDB1'))).toEqual({
      input: {
        name: 'ORCLPDB1',
        driver: 'oracle',
        host: 'db.example',
        port: 1521,
        user: 'scott',
        database: 'ORCLPDB1',
      },
      password: 'tiger',
    });
  });

  it('reads the JDBC thin forms with a service or a SID', () => {
    for (const url of [
      'oracle:thin:@//db.example:1521/SVC',
      'jdbc:oracle:thin:@//db.example:1521/SVC',
      'jdbc:oracle:thin:@db.example:1521:SVC',
    ]) {
      expect(ok(parseConnectionUrl(url)).input, url).toEqual({
        name: 'SVC',
        driver: 'oracle',
        host: 'db.example',
        port: 1521,
        database: 'SVC',
      });
    }
  });

  it('reads the user and password of a JDBC thin URL written user/password@', () => {
    for (const url of [
      'jdbc:oracle:thin:scott/tiger@db.example:1521:ORCL',
      'jdbc:oracle:thin:scott/tiger@//db.example:1521/ORCL',
    ]) {
      const value = ok(parseConnectionUrl(url));
      expect(value.input, url).toMatchObject({
        host: 'db.example',
        user: 'scott',
        database: 'ORCL',
      });
      expect(value.password, url).toBe('tiger');
    }
  });

  it('reads a host and service without a port, and a bare host', () => {
    expect(ok(parseConnectionUrl('oracle://db.example/SVC')).input).toEqual({
      name: 'SVC',
      driver: 'oracle',
      host: 'db.example',
      database: 'SVC',
    });
    expect(ok(parseConnectionUrl('oracle://db.example')).input).toEqual({
      name: 'db.example',
      driver: 'oracle',
      host: 'db.example',
    });
    expect(ok(parseConnectionUrl('oracle://u@h/S/')).input).toMatchObject({
      user: 'u',
      database: 'S',
    });
  });

  it('reads IPv6 hosts in brackets', () => {
    expect(ok(parseConnectionUrl('oracle://[::1]:1521/SVC')).input).toMatchObject({
      host: '::1',
      port: 1521,
      database: 'SVC',
    });
    expect(ok(parseConnectionUrl('oracle:thin:@//[2001:db8::1]:1522/S')).input).toMatchObject({
      host: '2001:db8::1',
      port: 1522,
    });
  });

  it('decodes a percent-encoded password and keeps an empty one out', () => {
    expect(ok(parseConnectionUrl('oracle://u:p%40ss%2Fx@h:1521/S')).password).toBe('p@ss/x');
    expect(ok(parseConnectionUrl('oracle://u:@h/S'))).not.toHaveProperty('password');
  });

  it('ignores a port out of range and query parameters', () => {
    expect(ok(parseConnectionUrl('oracle://h:99999/S')).input).not.toHaveProperty('port');
    expect(ok(parseConnectionUrl('oracle://h:0/S')).input).not.toHaveProperty('port');
    expect(ok(parseConnectionUrl('oracle://h:1521/S?x=1')).input).toEqual({
      name: 'S',
      driver: 'oracle',
      host: 'h',
      port: 1521,
      database: 'S',
    });
  });

  it('needs a host', () => {
    expect(parseConnectionUrl('oracle:thin:@')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseConnectionUrl('oracle://')).toMatchObject({ ok: false });
    expect(parseConnectionUrl('oracle://u:p@:1521/S')).toMatchObject({ ok: false });
    expect(parseConnectionUrl('oracle://h:abc/S')).toMatchObject({ ok: false });
  });
});

describe('compatible servers (V6.5)', () => {
  it('reads cockroachdb:// and yugabytedb:// as PostgreSQL, tidb:// as MySQL', () => {
    expect(urlDriver('cockroachdb://root@h:26257/defaultdb')).toBe('postgres');
    expect(urlDriver('cockroach://h')).toBe('postgres');
    expect(urlDriver('yugabytedb://h:5433/yugabyte')).toBe('postgres');
    expect(urlDriver('tidb://root@h:4000/test')).toBe('mysql');
  });

  it('fills the form from a CockroachDB URL with its port and database', () => {
    const result = parseConnectionUrl('cockroachdb://root:secret@crdb.example:26257/defaultdb');
    expect(result.ok && result.value).toMatchObject({
      input: {
        driver: 'postgres',
        host: 'crdb.example',
        port: 26257,
        user: 'root',
        database: 'defaultdb',
      },
      password: 'secret',
    });
  });
});

describe('Redis URLs (V7.1)', () => {
  it('knows redis, rediss and the Valkey schemes', () => {
    for (const scheme of ['redis', 'rediss', 'valkey', 'valkeys', 'REDIS']) {
      expect(urlDriver(`${scheme}://h`)).toBe('redis');
    }
  });

  it('reads the ACL user, password, port and database number, named by the host', () => {
    expect(ok(parseConnectionUrl('redis://app:s%40cret@cache.example:6380/2'))).toEqual({
      input: {
        name: 'cache.example',
        driver: 'redis',
        host: 'cache.example',
        port: 6380,
        user: 'app',
        database: '2',
      },
      password: 's@cret',
    });
  });

  it('takes a password without a user, as the default user signs in', () => {
    const parsed = ok(parseConnectionUrl('redis://:only-pass@localhost'));
    expect(parsed.input.user).toBeUndefined();
    expect(parsed.password).toBe('only-pass');
    expect(parsed.input.port).toBeUndefined();
  });

  it('reads the database from ?db= as some clients write it', () => {
    expect(ok(parseConnectionUrl('redis://h?db=5')).input.database).toBe('5');
  });

  it('checks the certificate for rediss:// unless the URL turns it off', () => {
    expect(ok(parseConnectionUrl('rediss://h:6380')).input.ssl).toEqual({ mode: 'verify-full' });
    expect(ok(parseConnectionUrl('valkeys://h')).input.ssl).toEqual({ mode: 'verify-full' });
    expect(ok(parseConnectionUrl('rediss://h?ssl_cert_reqs=none')).input.ssl).toEqual({
      mode: 'require',
    });
    expect(ok(parseConnectionUrl('redis://h')).input.ssl).toBeUndefined();
    // An explicit TLS parameter wins over the scheme.
    expect(ok(parseConnectionUrl('redis://h?tls=true')).input.ssl).toEqual({ mode: 'require' });
  });

  it('needs a host', () => {
    expect(parseConnectionUrl('redis:///0')).toEqual({ ok: false, problem: 'no-host' });
  });
});
