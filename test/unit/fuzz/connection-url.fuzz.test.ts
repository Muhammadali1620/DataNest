import { describe, expect, it } from 'vitest';
import {
  parseConnectionUrl,
  suggestedName,
  urlDriver,
} from '../../../src/shared/connection-url';
import { pick, pieces, seeded } from '../../helpers/fuzz';

const SCHEMES = [
  'mysql',
  'mariadb',
  'postgres',
  'postgresql',
  'sqlite',
  'mssql',
  'sqlserver',
  'clickhouse',
  'oracle',
  'redis',
  'rediss',
  'mongodb',
  'mongodb+srv',
  'http',
  'https',
  'etcd',
  'kafka',
  'kafkas',
  'zookeeper',
  'zk',
  'amqp',
  'libsql',
  'cassandra',
  'neo4j',
  'bolt',
  'influxdb',
  'loki',
  'nope',
  '',
];

const PARTS = [
  '://',
  ':',
  '@',
  '/',
  '?',
  '&',
  '=',
  '#',
  '%',
  '%41',
  '%zz',
  '%E3%81',
  '[',
  ']',
  '::1',
  '[::1]',
  ',',
  '.',
  ' ',
  'user',
  'p@ss',
  'host',
  '127.0.0.1',
  '65535',
  '65536',
  '-1',
  '0',
  'db',
  'sslmode=require',
  'sasl=plain',
  'tls=1',
  'sessionTimeout=30',
  'é',
  '日本',
  '\u{1F600}',
  '\\',
  "'",
  '"',
];

describe('connection URLs on random text', () => {
  it('are read or refused with a reason, never with an exception', () => {
    const random = seeded(31337);
    for (let round = 0; round < 8000; round += 1) {
      const text = `${pick(random, SCHEMES)}${pieces(random, PARTS, 10)}`;
      const label = JSON.stringify(text);
      const result = parseConnectionUrl(text);
      expect(typeof result.ok, label).toBe('boolean');
      if (result.ok) {
        expect(Number.isInteger(result.value.input.port ?? 0), label).toBe(true);
        expect(result.value.input.port ?? 1, label).toBeGreaterThanOrEqual(0);
        expect(result.value.input.port ?? 1, label).toBeLessThanOrEqual(65535);
        expect(typeof suggestedName(result.value.input), label).toBe('string');
        expect(urlDriver(text), label).toBeDefined();
      }
    }
  });
});
