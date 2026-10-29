import { describe, expect, it } from 'vitest';
import {
  connectionsFromEnv,
  isEnvFileName,
  parseDotenv,
  sameTarget,
} from '../../../src/services/env-import';

describe('parseDotenv', () => {
  it('reads plain, exported and commented lines', () => {
    const vars = parseDotenv(
      ['# comment', '', 'A=1', 'export B = two  ', 'C=three # note', 'D=', 'E=#x', 'bad line'].join(
        '\n',
      ),
    );
    expect([...vars]).toEqual([
      ['A', '1'],
      ['B', 'two'],
      ['C', 'three'],
      ['D', ''],
      ['E', ''],
    ]);
  });

  it('keeps # inside a value that has no space before it', () => {
    expect(parseDotenv('URL=mysql://u:p#1@h/d').get('URL')).toBe('mysql://u:p#1@h/d');
  });

  it('reads quoted values, with escapes only in double quotes', () => {
    const vars = parseDotenv(
      [`S='a #b \\n $X'`, `D="line\\nnext \\"q\\" \\\\"`, 'B=`tick`', 'X=x'].join('\n'),
    );
    expect(vars.get('S')).toBe('a #b \\n $X');
    expect(vars.get('D')).toBe('line\nnext "q" \\');
    expect(vars.get('B')).toBe('tick');
  });

  it('reads a quoted value over several lines and Windows line ends', () => {
    const vars = parseDotenv('KEY="first\r\nsecond"\r\nNEXT=1\r\n');
    expect(vars.get('KEY')).toBe('first\nsecond');
    expect(vars.get('NEXT')).toBe('1');
  });

  it('expands variables from the same file, with defaults and escapes', () => {
    const vars = parseDotenv(
      [
        'USER=app',
        'PASS=s3cret',
        'URL=postgres://${USER}:$PASS@${HOST:-localhost}:${PORT-5432}/db',
        'PRICE=\\$5',
        "RAW='${USER}'",
        'LATER=${DEFINED_BELOW}',
        'DEFINED_BELOW=yes',
      ].join('\n'),
    );
    expect(vars.get('URL')).toBe('postgres://app:s3cret@localhost:5432/db');
    expect(vars.get('PRICE')).toBe('$5');
    expect(vars.get('RAW')).toBe('${USER}');
    expect(vars.get('LATER')).toBe('yes');
  });

  it('stops expanding a variable that refers to itself', () => {
    expect(parseDotenv('A=${A}x').get('A')).toMatch(/x$/);
  });

  it('lets a later line win', () => {
    expect(parseDotenv('A=1\nA=2').get('A')).toBe('2');
  });
});

describe('connectionsFromEnv', () => {
  it('finds URLs, keeping the password apart', () => {
    const found = connectionsFromEnv(
      parseDotenv(
        [
          'DATABASE_URL=postgres://app:pw@db:5432/shop',
          'CACHE_URL=memcached://cache:11211',
          'HOMEPAGE=https://example.com',
        ].join('\n'),
      ),
    );
    expect(found).toEqual([
      {
        input: {
          name: 'shop',
          driver: 'postgres',
          host: 'db',
          port: 5432,
          user: 'app',
          database: 'shop',
        },
        password: 'pw',
        source: 'DATABASE_URL',
      },
    ]);
  });

  it('builds a connection from separate variables of one prefix', () => {
    const found = connectionsFromEnv(
      parseDotenv(
        [
          'DB_CONNECTION=mysql',
          'DB_HOST=127.0.0.1',
          'DB_PORT=3306',
          'DB_DATABASE=laravel',
          'DB_USERNAME=root',
          'DB_PASSWORD=',
        ].join('\n'),
      ),
    );
    expect(found).toEqual([
      {
        input: {
          name: 'laravel',
          driver: 'mysql',
          host: '127.0.0.1',
          port: 3306,
          user: 'root',
          database: 'laravel',
        },
        source: 'DB_*',
      },
    ]);
  });

  it('knows the libpq and Docker image variables', () => {
    const pg = connectionsFromEnv(
      parseDotenv('PGHOST=db\nPGUSER=me\nPGPASSWORD=pw\nPGDATABASE=app'),
    );
    expect(pg).toEqual([
      {
        input: { name: 'app', driver: 'postgres', host: 'db', user: 'me', database: 'app' },
        password: 'pw',
        source: 'PG*',
      },
    ]);
    const docker = connectionsFromEnv(
      parseDotenv('MYSQL_HOST=db\nMYSQL_USER=u\nMYSQL_PASSWORD=p\nMYSQL_DATABASE=d'),
    );
    expect(docker[0]?.input).toMatchObject({ driver: 'mysql', host: 'db', database: 'd' });
    const postgres = connectionsFromEnv(parseDotenv('POSTGRES_HOST=db\nPOSTGRES_DB=app'));
    expect(postgres[0]?.input).toMatchObject({ driver: 'postgres', database: 'app' });
  });

  it('guesses the database from the port when nothing else says', () => {
    expect(
      connectionsFromEnv(parseDotenv('APP_DB_HOST=h\nAPP_DB_PORT=5432'))[0]?.input.driver,
    ).toBe('postgres');
    expect(connectionsFromEnv(parseDotenv('X_HOST=h\nX_PORT=3306'))[0]?.input.driver).toBe('mysql');
  });

  it('skips groups whose database it cannot tell, or that have no host', () => {
    expect(connectionsFromEnv(parseDotenv('MEMCACHED_HOST=h\nMEMCACHED_PORT=11211'))).toEqual([]);
    expect(connectionsFromEnv(parseDotenv('SMTP_SERVER=mail\nHOST=x'))).toEqual([]);
    expect(connectionsFromEnv(parseDotenv('DB_CONNECTION=pgsql\nDB_PORT=5432'))).toEqual([]);
  });

  it('reads a Laravel SQLite file', () => {
    expect(
      connectionsFromEnv(parseDotenv('DB_CONNECTION=sqlite\nDB_DATABASE=database/app.sqlite')),
    ).toEqual([
      {
        input: { name: 'app.sqlite', driver: 'sqlite', file: 'database/app.sqlite' },
        source: 'DB_*',
      },
    ]);
  });

  it('lists a place once when a URL and its variables both describe it', () => {
    const found = connectionsFromEnv(
      parseDotenv(
        [
          'DB_HOST=db',
          'DB_PORT=5432',
          'DB_USER=app',
          'DB_NAME=shop',
          'DATABASE_URL=postgres://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}',
        ].join('\n'),
      ),
    );
    expect(found.map((candidate) => candidate.source)).toEqual(['DATABASE_URL']);
  });

  it('ignores a URL it cannot use', () => {
    expect(connectionsFromEnv(parseDotenv('DATABASE_URL=postgres://'))).toEqual([]);
  });
});

describe('isEnvFileName', () => {
  it('reads .env and its variants, not the templates', () => {
    for (const name of ['.env', '.env.local', '.env.development', '.env.production.local']) {
      expect(isEnvFileName(name)).toBe(true);
    }
    for (const name of [
      '.env.example',
      '.env.sample',
      '.env.template',
      '.env.dist',
      'env',
      '.envrc',
      'x.env',
    ]) {
      expect(isEnvFileName(name)).toBe(false);
    }
  });
});

describe('sameTarget', () => {
  it('compares where a connection points, not its name, and hosts without case', () => {
    const a = {
      name: 'a',
      driver: 'mysql' as const,
      host: 'DB',
      port: 3306,
      user: 'u',
      database: 'd',
    };
    expect(sameTarget(a, { ...a, name: 'b', host: 'db' })).toBe(true);
    expect(sameTarget(a, { ...a, database: 'other' })).toBe(false);
    expect(sameTarget(a, { ...a, driver: 'postgres' })).toBe(false);
  });
});

describe('SQL Server in .env files (V6.2)', () => {
  it('reads Laravel sqlsrv, Prisma sqlserver and plain mssql words', () => {
    for (const word of ['sqlsrv', 'sqlserver', 'mssql']) {
      const found = connectionsFromEnv(
        parseDotenv([`DB_CONNECTION=${word}`, 'DB_HOST=db', 'DB_DATABASE=shop'].join('\n')),
      );
      expect(
        found.map((candidate) => candidate.input.driver),
        word,
      ).toEqual(['mssql']);
    }
  });

  it('guesses SQL Server from port 1433 when nothing names the driver', () => {
    const [found] = connectionsFromEnv(
      parseDotenv(['DB_HOST=db', 'DB_PORT=1433', 'DB_USER=sa', 'DB_PASSWORD=x'].join('\n')),
    );
    expect(found?.input).toMatchObject({ driver: 'mssql', host: 'db', port: 1433, user: 'sa' });
    expect(found?.password).toBe('x');
  });

  it('reads a sqlserver:// URL', () => {
    const [found] = connectionsFromEnv(
      parseDotenv('DATABASE_URL=sqlserver://db:1433;database=shop;user=sa;password=p'),
    );
    expect(found?.input).toMatchObject({ driver: 'mssql', host: 'db', database: 'shop' });
  });
});

describe('ClickHouse in .env files (V6.3)', () => {
  it('reads a CLICKHOUSE_* group by its prefix', () => {
    const [found] = connectionsFromEnv(
      parseDotenv(['CLICKHOUSE_HOST=ch', 'CLICKHOUSE_USER=r', 'CLICKHOUSE_PASSWORD=p'].join('\n')),
    );
    expect(found?.input).toMatchObject({ driver: 'clickhouse', host: 'ch', user: 'r' });
    expect(found?.password).toBe('p');
  });

  it('guesses ClickHouse from port 8123 when nothing names the driver', () => {
    const [found] = connectionsFromEnv(parseDotenv(['DB_HOST=ch', 'DB_PORT=8123'].join('\n')));
    expect(found?.input).toMatchObject({ driver: 'clickhouse', host: 'ch', port: 8123 });
  });

  it('reads a clickhouse:// URL', () => {
    const [found] = connectionsFromEnv(parseDotenv('CLICKHOUSE_URL=clickhouse://r@ch:8123/events'));
    expect(found?.input).toMatchObject({ driver: 'clickhouse', host: 'ch', database: 'events' });
  });
});

describe('Oracle in .env files (V6.4)', () => {
  it('reads Laravel DB_CONNECTION=oracle with the service as the database', () => {
    const [found, ...rest] = connectionsFromEnv(
      parseDotenv(
        [
          'DB_CONNECTION=oracle',
          'DB_HOST=db',
          'DB_PORT=1521',
          'DB_DATABASE=ORCLPDB1',
          'DB_USERNAME=app',
          'DB_PASSWORD=pw',
        ].join('\n'),
      ),
    );
    expect(rest).toEqual([]);
    expect(found?.input).toMatchObject({
      driver: 'oracle',
      host: 'db',
      port: 1521,
      user: 'app',
      database: 'ORCLPDB1',
    });
    expect(found?.password).toBe('pw');
  });

  it("reads PHP's oci8 as Oracle", () => {
    const [found] = connectionsFromEnv(
      parseDotenv(['DB_CONNECTION=oci8', 'DB_HOST=db'].join('\n')),
    );
    expect(found?.input).toMatchObject({ driver: 'oracle', host: 'db' });
  });

  it('guesses Oracle from port 1521 when nothing names the driver', () => {
    const [found] = connectionsFromEnv(parseDotenv(['DB_HOST=db', 'DB_PORT=1521'].join('\n')));
    expect(found?.input).toMatchObject({ driver: 'oracle', host: 'db', port: 1521 });
  });

  it('reads an ORACLE_* group by its prefix', () => {
    const [found] = connectionsFromEnv(
      parseDotenv(['ORACLE_HOST=ora', 'ORACLE_USER=u', 'ORACLE_PASSWORD=p'].join('\n')),
    );
    expect(found?.input).toMatchObject({ driver: 'oracle', host: 'ora', user: 'u' });
    expect(found?.password).toBe('p');
  });

  it('reads oracle:// and JDBC thin URLs', () => {
    const [url] = connectionsFromEnv(parseDotenv('ORACLE_URL=oracle://u:p@ora:1521/SVC'));
    expect(url?.input).toMatchObject({ driver: 'oracle', host: 'ora', database: 'SVC' });
    expect(url?.password).toBe('p');
    const [jdbc] = connectionsFromEnv(parseDotenv('DATABASE_URL=jdbc:oracle:thin:@//ora:1521/SVC'));
    expect(jdbc?.input).toMatchObject({ driver: 'oracle', host: 'ora', port: 1521 });
  });
});

describe('compatible servers in .env files (V6.5)', () => {
  it.each([
    ['cockroachdb', 'postgres'],
    ['yugabytedb', 'postgres'],
    ['tidb', 'mysql'],
  ])('reads DB_CONNECTION=%s with the %s driver', (word, driver) => {
    const [found] = connectionsFromEnv(
      parseDotenv([`DB_CONNECTION=${word}`, 'DB_HOST=db'].join('\n')),
    );
    expect(found?.input).toMatchObject({ driver, host: 'db' });
  });

  it.each([
    [26257, 'postgres'],
    [5433, 'postgres'],
    [4000, 'mysql'],
  ])('takes port %i for %s when nothing names the database', (port, driver) => {
    const [found] = connectionsFromEnv(parseDotenv(['DB_HOST=db', `DB_PORT=${port}`].join('\n')));
    expect(found?.input).toMatchObject({ driver, port });
  });
});

describe('Redis in .env files (V7.1)', () => {
  it("reads Laravel's REDIS_* group next to the database, with null meaning no password", () => {
    const found = connectionsFromEnv(
      parseDotenv(
        [
          'DB_CONNECTION=mysql',
          'DB_HOST=db',
          'REDIS_CLIENT=phpredis',
          'REDIS_HOST=127.0.0.1',
          'REDIS_PASSWORD=null',
          'REDIS_PORT=6379',
          'REDIS_DB=1',
        ].join('\n'),
      ),
    );
    const redis = found.find((candidate) => candidate.input.driver === 'redis');
    expect(found.map((candidate) => candidate.input.driver).sort()).toEqual(['mysql', 'redis']);
    expect(redis?.input).toEqual({
      name: '127.0.0.1',
      driver: 'redis',
      host: '127.0.0.1',
      port: 6379,
      database: '1',
    });
    expect(redis?.password).toBeUndefined();
    expect(redis?.source).toBe('REDIS_*');
  });

  it('keeps a real Redis password and an ACL user', () => {
    const [found] = connectionsFromEnv(
      parseDotenv(['REDIS_HOST=cache', 'REDIS_USERNAME=app', 'REDIS_PASSWORD=pw'].join('\n')),
    );
    expect(found?.input).toMatchObject({ driver: 'redis', host: 'cache', user: 'app' });
    expect(found?.password).toBe('pw');
  });

  it('reads REDIS_URL, Valkey and a bare port 6379', () => {
    const fromUrl = connectionsFromEnv(parseDotenv('REDIS_URL=rediss://:pw@cache:6380/0'));
    expect(fromUrl[0]?.input).toMatchObject({
      driver: 'redis',
      host: 'cache',
      port: 6380,
      ssl: { mode: 'verify-full' },
    });
    expect(fromUrl[0]?.password).toBe('pw');
    const valkey = connectionsFromEnv(parseDotenv('VALKEY_HOST=v1'));
    expect(valkey[0]?.input.driver).toBe('redis');
    const byPort = connectionsFromEnv(parseDotenv(['CACHE_HOST=c', 'CACHE_PORT=6379'].join('\n')));
    expect(byPort[0]?.input.driver).toBe('redis');
  });
});

describe('MongoDB in .env files (V7.5)', () => {
  it('reads MONGO_URL and MONGODB_URI, replica sets and SRV records included', () => {
    const found = connectionsFromEnv(
      parseDotenv(
        [
          'MONGO_URL=mongodb://app:pw@db1:27017,db2/shop?replicaSet=rs0',
          'MONGODB_URI=mongodb+srv://u:p@cluster0.x.net/logs',
        ].join('\n'),
      ),
    );
    expect(found.map((candidate) => candidate.input.driver)).toEqual(['mongodb', 'mongodb']);
    expect(found[0]?.input).toMatchObject({
      host: 'db1',
      port: 27_017,
      user: 'app',
      database: 'shop',
      mongo: { mode: 'replicaSet', replicaSet: 'rs0', nodes: [{ host: 'db2' }] },
    });
    expect(found[0]?.password).toBe('pw');
    expect(found[1]?.input).toMatchObject({ host: 'cluster0.x.net', mongo: { mode: 'srv' } });
  });

  it("reads Laravel's DB_CONNECTION=mongodb group and a bare port 27017", () => {
    const [laravel] = connectionsFromEnv(
      parseDotenv(['DB_CONNECTION=mongodb', 'DB_HOST=mongo', 'DB_DATABASE=app'].join('\n')),
    );
    expect(laravel?.input).toMatchObject({ driver: 'mongodb', host: 'mongo', database: 'app' });
    const [byPort] = connectionsFromEnv(parseDotenv(['DB_HOST=m', 'DB_PORT=27017'].join('\n')));
    expect(byPort?.input).toMatchObject({ driver: 'mongodb', port: 27_017 });
  });
});

describe('Elasticsearch in .env files (V7.8)', () => {
  it('reads ELASTICSEARCH_URL and OPENSEARCH_URL even as plain http(s) URLs', () => {
    const found = connectionsFromEnv(
      parseDotenv(
        [
          'ELASTICSEARCH_URL=https://elastic:pw@search.example.com:9243',
          'OPENSEARCH_URL=http://localhost:9201',
          'OTHER_URL=https://example.com',
        ].join('\n'),
      ),
    );
    expect(found.map((candidate) => [candidate.source, candidate.input.host])).toEqual([
      ['ELASTICSEARCH_URL', 'search.example.com'],
      ['OPENSEARCH_URL', 'localhost'],
    ]);
    expect(found[0]?.input).toMatchObject({
      driver: 'elasticsearch',
      user: 'elastic',
      ssl: { mode: 'verify-full' },
    });
    expect(found[0]?.password).toBe('pw');
  });

  it('takes a group named ELASTIC_* or on port 9200', () => {
    const [named] = connectionsFromEnv(
      parseDotenv(['ELASTIC_HOST=es', 'ELASTIC_PASSWORD=pw'].join('\n')),
    );
    expect(named?.input).toMatchObject({ driver: 'elasticsearch', host: 'es' });
    const [byPort] = connectionsFromEnv(
      parseDotenv(['SEARCH_HOST=s', 'SEARCH_PORT=9200'].join('\n')),
    );
    expect(byPort?.input).toMatchObject({ driver: 'elasticsearch', port: 9200 });
  });
});
