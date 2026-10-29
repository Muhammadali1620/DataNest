import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { listRedisDatabases, parseKeyspace } from '../../../../src/services/redis/redis-databases';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';

const KEYSPACE =
  '# Keyspace\r\ndb0:keys=2027,expires=1,avg_ttl=86000\r\ndb1:keys=2,expires=0,avg_ttl=0\r\ndb15:keys=1,expires=0,avg_ttl=0\r\n';

function server(options: { databases?: string | Error; keyspace?: string } = {}): FakeRedisSession {
  return new FakeRedisSession((words) => {
    if (words[0] === 'INFO') {
      return bulk(options.keyspace ?? KEYSPACE);
    }
    if (words[0] === 'CONFIG') {
      const count = options.databases ?? '16';
      return count instanceof Error ? count : [bulk('databases'), bulk(count)];
    }
    return null;
  });
}

describe('parseKeyspace', () => {
  it('reads keys and expires per database', () => {
    expect(parseKeyspace(KEYSPACE)).toEqual(
      new Map([
        [0, { keys: 2027, expires: 1 }],
        [1, { keys: 2, expires: 0 }],
        [15, { keys: 1, expires: 0 }],
      ]),
    );
  });

  it('skips headers, other fields and broken lines', () => {
    expect(
      parseKeyspace('# Keyspace\nused_memory:1\ndb2:expires=1\ndb3:keys=x\ndb4:keys=7'),
    ).toEqual(new Map([[4, { keys: 7, expires: 0 }]]));
    expect(parseKeyspace('')).toEqual(new Map());
  });
});

describe('listRedisDatabases', () => {
  it('lists all 16 databases of a usual server, empty ones too', async () => {
    const databases = await listRedisDatabases(server(), 0);
    expect(databases).toHaveLength(16);
    expect(databases[0]).toEqual({ index: 0, keys: 2027, expires: 1 });
    expect(databases[2]).toEqual({ index: 2, keys: 0, expires: 0 });
    expect(databases[15]?.keys).toBe(1);
  });

  it('assumes 16 when the server will not say', async () => {
    const databases = await listRedisDatabases(
      server({ databases: new DbError('permission-denied', 'NOPERM') }),
      0,
    );
    expect(databases.map((database) => database.index)).toEqual([...Array(16).keys()]);
  });

  it('lists only databases with keys, 0 and the opened one on a server with hundreds', async () => {
    const databases = await listRedisDatabases(server({ databases: '256' }), 40);
    expect(databases.map((database) => database.index)).toEqual([0, 1, 15, 40]);
  });

  it('shows a database beyond the count when it is the one opened or holds keys', async () => {
    const databases = await listRedisDatabases(
      server({ databases: '4', keyspace: 'db9:keys=3,expires=0' }),
      7,
    );
    expect(databases.map((database) => database.index)).toEqual([0, 1, 2, 3, 7, 9]);
  });

  it('gives a cluster database 0 with the keys of every master added up', async () => {
    const session = server();
    const cluster = new FakeRedisSession(undefined, 'cluster');
    cluster.masters = () => [
      bulk('db0:keys=2,expires=1'),
      bulk('db0:keys=3,expires=0'),
      bulk('# Keyspace'),
    ];
    expect(await listRedisDatabases(cluster, 0)).toEqual([{ index: 0, keys: 5, expires: 1 }]);
    expect(session.calls).toEqual([]);
  });
});
