import { describe, expect, it } from 'vitest';
import { baseUrl, curlCommand, shellQuote } from '../../../../src/services/elasticsearch/curl';
import type { ConnectionConfig } from '../../../../src/shared/connection';

const config: ConnectionConfig = {
  id: 'e',
  name: 'es',
  driver: 'elasticsearch',
  host: 'search.local',
  port: 9200,
  user: 'elastic',
  elastic: { auth: 'basic' },
};

describe('shellQuote', () => {
  it('quotes for sh, a quote inside included', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote('$HOME `x`')).toBe("'$HOME `x`'");
  });
});

describe('baseUrl', () => {
  it('builds the address with the scheme of TLS, the port and a path prefix', () => {
    expect(baseUrl(config)).toBe('http://search.local:9200');
    expect(
      baseUrl({
        ...config,
        ssl: { mode: 'verify-full' },
        elastic: { auth: 'basic', pathPrefix: '/es/' },
      }),
    ).toBe('https://search.local:9200/es');
    expect(baseUrl({ ...config, host: '::1' })).toBe('http://[::1]:9200');
  });
});

describe('curlCommand', () => {
  it('writes a search with its JSON body and lets curl ask for the password', () => {
    expect(
      curlCommand(
        {
          method: 'GET',
          path: '/products/_search',
          body: '{"query":{"match":{"name":"it\'s"}}}',
          ndjson: false,
        },
        config,
      ),
    ).toBe(
      `curl -X GET 'http://search.local:9200/products/_search' -u 'elastic' -H 'Content-Type: application/json' --data-binary '{"query":{"match":{"name":"it'\\''s"}}}'`,
    );
  });

  it('takes an API key from the shell, never the key itself', () => {
    const command = curlCommand(
      { method: 'GET', path: '/_cat/indices', ndjson: false },
      { ...config, elastic: { auth: 'apiKey' } },
    );
    expect(command).toBe(
      `curl -X GET 'http://search.local:9200/_cat/indices' -H "Authorization: ApiKey \${ELASTIC_API_KEY}"`,
    );
  });

  it('ends NDJSON with a newline and says so in the type', () => {
    const command = curlCommand(
      { method: 'POST', path: '/_bulk', body: '{"index":{}}\n{"a":1}', ndjson: true },
      config,
    );
    expect(command).toContain("-H 'Content-Type: application/x-ndjson'");
    expect(command.endsWith(`--data-binary '{"index":{}}\n{"a":1}\n'`)).toBe(true);
  });

  it('follows the TLS settings: -k without checks, the CA when checked', () => {
    expect(
      curlCommand(
        { method: 'GET', path: '/', ndjson: false },
        { ...config, ssl: { mode: 'require' } },
      ),
    ).toContain(' -k');
    expect(
      curlCommand(
        { method: 'GET', path: '/', ndjson: false },
        { ...config, ssl: { mode: 'verify-ca', ca: '/etc/ca.pem' } },
      ),
    ).toContain("--cacert '/etc/ca.pem'");
  });

  it('signs in with nothing when there is no user', () => {
    expect(
      curlCommand({ method: 'GET', path: '/', ndjson: false }, { ...config, user: undefined }),
    ).toBe("curl -X GET 'http://search.local:9200/'");
  });
});
