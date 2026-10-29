import { describe, expect, it } from 'vitest';
import { resultState } from '../../../../src/services/elasticsearch/result-view';
import { elasticResultProtocol } from '../../../../src/shared/protocols/elastic-result';
import { json } from '../../../helpers/fake-elastic';

function state(body: unknown, status = 200) {
  return resultState({
    connectionName: 'Search',
    request: 'POST /products/_search',
    response: json(body, status),
    tookMs: 7,
  });
}

describe('resultState (V7.8)', () => {
  it('shows hits as a table: meta columns, then the fields of _source', () => {
    const result = state(
      '{"took":3,"hits":{"total":{"value":10000,"relation":"gte"},"hits":[' +
        '{"_index":"products","_id":"big","_score":1.0,"_source":{"name":"Big","stock":9007199254740993}},' +
        '{"_index":"products","_id":"p1","_score":0.5,"_source":{"sku":"SKU-1","name":"One"}}]}}',
    );
    expect(elasticResultProtocol.webview.events.state.parse(result)).toEqual(result);
    expect(result.summary).toEqual({
      kind: 'hits',
      total: '10000',
      relation: 'gte',
      shown: 2,
      took: 3,
    });
    expect(result.columns).toEqual(['_index', '_id', '_score', 'name', 'stock', 'sku']);
    expect(result.rows[0]?.cells.map((cell) => cell?.text ?? null)).toEqual([
      'products',
      'big',
      '1.0',
      'Big',
      '9007199254740993',
      null,
    ]);
    expect(result.rows[0]?.cells[4]?.type).toBe('number');
    expect(result.rows[1]?.text).toContain('"sku": "SKU-1"');
    expect(result.text).toContain('"stock": 9007199254740993');
    expect(result.truncated).toBe(false);
  });

  it('reads the total of old servers, and no hits as no table', () => {
    expect(state({ hits: { total: 5, hits: [] } }).summary).toEqual({
      kind: 'hits',
      total: '5',
      shown: 0,
    });
    expect(state({ hits: { total: 5, hits: [] } }).columns).toEqual([]);
  });

  it('says how many documents a count found', () => {
    expect(state({ count: 31, _shards: {} }).summary).toEqual({ kind: 'count', total: '31' });
  });

  it('says why a request failed', () => {
    const result = state(
      { error: { root_cause: [{ type: 'index_not_found_exception', reason: 'no such index' }] } },
      404,
    );
    expect(result.status).toBe(404);
    expect(result.summary).toEqual({
      kind: 'error',
      error: 'index_not_found_exception: no such index',
    });
    expect(result.rows).toEqual([]);
  });

  it('shows text that is not JSON as it came, and an empty answer as such', () => {
    const cat = resultState({
      connectionName: 'S',
      request: 'GET /_cat/indices?v',
      response: {
        status: 200,
        body: 'health status index\ngreen open products\n',
        contentType: 'text/plain',
      },
      tookMs: 1,
    });
    expect(cat.text).toBe('health status index\ngreen open products\n');
    expect(cat.summary).toBeUndefined();
    const head = resultState({
      connectionName: 'S',
      request: 'HEAD /products',
      response: { status: 200, body: '', contentType: '' },
      tookMs: 1,
    });
    expect(head.summary).toEqual({ kind: 'empty' });
    const proxy = resultState({
      connectionName: 'S',
      request: 'GET /',
      response: { status: 502, body: 'Bad Gateway', contentType: 'text/plain' },
      tookMs: 1,
    });
    expect(proxy.summary).toEqual({ kind: 'error', error: 'HTTP 502: Bad Gateway' });
  });

  it('cuts a huge answer and says so', () => {
    const result = state({ text: 'x'.repeat(3 * 1024 * 1024) });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThan(3 * 1024 * 1024);
  });

  it('lays a plain answer out', () => {
    expect(state({ acknowledged: true }).text).toBe('{\n  "acknowledged": true\n}');
    expect(state({ acknowledged: true }).summary).toBeUndefined();
  });
});
