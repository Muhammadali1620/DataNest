import { describe, expect, it } from 'vitest';
import {
  parseRequest,
  pathSegments,
  requestAt,
  requestEffect,
  RequestSyntaxError,
  splitRequests,
} from '../../../../src/core/elastic/requests';

function parsed(text: string) {
  const [request] = splitRequests(text);
  if (request === undefined) {
    throw new Error('no request');
  }
  return parseRequest(request, text);
}

function effect(text: string): string {
  return requestEffect(parsed(text));
}

describe('splitRequests (V7.8)', () => {
  const document = [
    '# the products',
    'GET /products/_search',
    '{',
    '  "query": { "match_all": {} }',
    '}',
    '',
    'get _cat/indices?v',
    '// another',
    'DELETE /old',
    '',
  ].join('\n');

  it('starts a request at each method line and takes the lines below as its body', () => {
    expect(splitRequests(document).map((one) => [one.method, one.path, one.body])).toEqual([
      ['GET', '/products/_search', '{\n  "query": { "match_all": {} }\n}'],
      ['GET', '_cat/indices?v', ''],
      ['DELETE', '/old', ''],
    ]);
  });

  it('gives offsets of the method line and the last body line', () => {
    const [first] = splitRequests(document);
    expect(document.slice(first?.start, first?.end)).toBe(
      'GET /products/_search\n{\n  "query": { "match_all": {} }\n}',
    );
    expect(
      document.slice(first?.bodyStart, first?.bodyStart === undefined ? 0 : first.bodyStart + 1),
    ).toBe('{');
  });

  it('finds the request at the cursor, or the one before it', () => {
    expect(requestAt(document, document.indexOf('match_all'))?.path).toBe('/products/_search');
    expect(requestAt(document, document.indexOf('// another'))?.path).toBe('_cat/indices?v');
    expect(requestAt(document, 0)?.path).toBe('/products/_search');
    expect(requestAt('no request here', 3)).toBeUndefined();
  });

  it('needs a path after the method', () => {
    expect(splitRequests('GET\nPOST')).toEqual([]);
    expect(splitRequests('  PUT  /a  \r\n{}')).toHaveLength(1);
  });
});

describe('parseRequest (V7.8)', () => {
  it('adds the leading slash and sends JSON on one line, numbers unchanged', () => {
    expect(parsed('POST products/_search\n{\n "size": 1, "id": 9007199254740993\n}')).toMatchObject(
      {
        method: 'POST',
        path: '/products/_search',
        ndjson: false,
        body: '{"size":1,"id":9007199254740993}',
      },
    );
    expect(parsed('GET /')).toEqual({ method: 'GET', path: '/', ndjson: false });
  });

  it('sends _bulk and _msearch as one JSON per line', () => {
    expect(
      parsed(
        'POST /_bulk\n{ "index": { "_index": "a" } }\n{ "x": 1 }\n# a comment\n{ "delete": { "_index": "a", "_id": "1" } }',
      ),
    ).toMatchObject({
      ndjson: true,
      body: '{"index":{"_index":"a"}}\n{"x":1}\n{"delete":{"_index":"a","_id":"1"}}\n',
    });
    expect(parsed('GET /a/_msearch\n{}\n{"query":{}}').ndjson).toBe(true);
    expect(parsed('GET /_msearch/template\n{}').ndjson).toBe(true);
  });

  it('leaves comment lines out of a body', () => {
    expect(parsed('POST /a/_search\n{\n  # why\n  "size": 1\n}').body).toBe('{"size":1}');
  });

  it('says where in the document a body is not JSON', () => {
    const text = 'GET /a\n\nPOST /b/_search\n{\n  "size": 1,\n}';
    const [, second] = splitRequests(text);
    if (second === undefined) {
      throw new Error('no request');
    }
    let error: unknown;
    try {
      parseRequest(second, text);
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(RequestSyntaxError);
    expect((error as RequestSyntaxError).offset).toBe(text.lastIndexOf('}'));
  });

  it('splits a path into segments without the query', () => {
    expect(pathSegments('/a/_doc/1?refresh=true')).toEqual(['a', '_doc', '1']);
    expect(pathSegments('/')).toEqual([]);
  });
});

describe('requestEffect (V7.8)', () => {
  it.each([
    'GET /products/_search',
    'HEAD /products',
    'POST /products/_search\n{}',
    'POST /_search/scroll\n{}',
    'POST /products/_count\n{}',
    'POST /_mget\n{}',
    'POST /_sql?format=txt\n{"query":"SELECT 1"}',
    'POST /products/_explain/1\n{}',
    'POST /products/_validate/query\n{}',
    'POST /_analyze\n{}',
    'POST /products/_pit?keep_alive=1m',
    'DELETE /_search/scroll\n{}',
    'POST /_query\n{"query":"FROM x"}',
  ])('reads: %s', (text) => {
    expect(effect(text)).toBe('read');
  });

  it.each([
    'PUT /products',
    'POST /products/_doc\n{}',
    'PUT /products/_doc/1\n{}',
    'POST /products/_update/1\n{}',
    'DELETE /products/_doc/1',
    'POST /_bulk\n{"index":{}}\n{}',
    'POST /products/_delete_by_query\n{"query":{"term":{"a":1}}}',
    'POST /products/_update_by_query\n{"query":{"term":{"a":1}}}',
    'POST /_reindex\n{}',
    'POST /products/_close',
    'PUT /_cluster/settings\n{}',
    'DELETE /_index_template/x',
  ])('writes: %s', (text) => {
    expect(effect(text)).toBe('write');
  });

  it.each([
    'DELETE /products',
    'DELETE /logs-*',
    'DELETE /_all',
    'DELETE /*',
    'POST /products/_delete_by_query\n{"query":{"match_all":{}}}',
    'POST /products/_delete_by_query',
    'POST /products/_update_by_query\n{"script":{"source":"ctx._source.x = 1"}}',
  ])('writes something hard to undo: %s', (text) => {
    expect(effect(text)).toBe('dangerous');
  });
});
