import { describe, expect, it } from 'vitest';
import { parseConnectionUrl, urlDriver } from '../../../src/shared/connection-url';
import {
  isElasticUrl,
  parseElasticHttpUrl,
  parseElasticUrl,
} from '../../../src/shared/elastic-url';

function parsed(result: ReturnType<typeof parseElasticUrl>) {
  if (!result.ok) {
    throw new Error(result.problem);
  }
  return result.value;
}

describe('Elasticsearch URLs (V7.8)', () => {
  it('reads elasticsearch://, opensearch:// and es:// with the password apart', () => {
    expect(parsed(parseElasticUrl('elasticsearch://elastic:p%40ss@es.local:9201'))).toEqual({
      input: {
        name: 'es.local',
        driver: 'elasticsearch',
        host: 'es.local',
        port: 9201,
        user: 'elastic',
      },
      password: 'p@ss',
    });
    expect(parsed(parseElasticUrl('opensearch://os')).input).toMatchObject({
      driver: 'elasticsearch',
      host: 'os',
    });
    expect(parsed(parseElasticUrl('es://h')).input.port).toBeUndefined();
    expect(urlDriver('opensearch://x')).toBe('elasticsearch');
    expect(isElasticUrl('es+https://h')).toBe(true);
    expect(isElasticUrl('https://h')).toBe(false);
  });

  it('turns TLS on for +https or ssl=true, with 443 as the https port', () => {
    expect(parsed(parseElasticUrl('elasticsearch+https://h')).input).toMatchObject({
      port: 443,
      ssl: { mode: 'verify-full' },
    });
    expect(parsed(parseElasticUrl('elasticsearch://h:9200?ssl=true')).input).toMatchObject({
      port: 9200,
      ssl: { mode: 'verify-full' },
    });
  });

  it('keeps a path as the prefix of a proxy', () => {
    expect(parsed(parseElasticUrl('elasticsearch://h/es/')).input.elastic).toEqual({
      auth: 'basic',
      pathPrefix: '/es',
    });
  });

  it('reads the plain http(s) URLs apps keep', () => {
    expect(parsed(parseElasticHttpUrl('https://u:p@cloud.es.io:9243')).input).toMatchObject({
      host: 'cloud.es.io',
      port: 9243,
      user: 'u',
      ssl: { mode: 'verify-full' },
    });
    expect(parsed(parseElasticHttpUrl('http://localhost:9200')).input.ssl).toBeUndefined();
    expect(parseElasticHttpUrl('ftp://x')).toEqual({ ok: false, problem: 'not-a-url' });
  });

  it('refuses what it cannot read', () => {
    expect(parseElasticUrl('mysql://h')).toEqual({ ok: false, problem: 'not-a-url' });
    expect(parseElasticUrl('elasticsearch://')).toEqual({ ok: false, problem: 'no-host' });
    expect(parseElasticUrl('elasticsearch://h:bad')).toEqual({ ok: false, problem: 'not-a-url' });
    const result = parseConnectionUrl('es://u@h:9200');
    expect(result.ok && result.value.input.driver).toBe('elasticsearch');
  });
});
