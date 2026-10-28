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
          'CACHE_URL=redis://cache:6379',
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
    expect(connectionsFromEnv(parseDotenv('REDIS_HOST=h\nREDIS_PORT=6379'))).toEqual([]);
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
