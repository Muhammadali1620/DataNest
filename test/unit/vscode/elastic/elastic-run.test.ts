import { describe, expect, it } from 'vitest';
import { splitRequests } from '../../../../src/core/elastic/requests';
import type { SafeMode } from '../../../../src/services/safe-mode';
import {
  type ElasticRunQuestion,
  parseInDocument,
  requestTemplate,
  runElasticRequest,
} from '../../../../src/vscode/elastic/elastic-run';
import { FakeElasticSession, json } from '../../../helpers/fake-elastic';

function setup(
  options: { readOnly?: boolean; production?: boolean; safeMode?: SafeMode; answer?: boolean } = {},
) {
  const session = new FakeElasticSession(() => json({ acknowledged: true }));
  const questions: ElasticRunQuestion[] = [];
  let clock = 0;
  const send = async (text: string, timeoutMs = 0) => {
    const [request] = splitRequests(text);
    if (request === undefined) {
      throw new Error('no request');
    }
    return await runElasticRequest(
      {
        session: () => Promise.resolve(session),
        policy: {
          name: 'Search',
          production: options.production === true,
          readOnly: options.readOnly === true,
        },
        safeMode: options.safeMode ?? 'confirm',
        timeoutMs,
        ask: (question) => {
          questions.push(question);
          return Promise.resolve(options.answer ?? true);
        },
        texts: { readOnly: 'Read-only', blocked: 'Blocked' },
        now: () => (clock += 4),
      },
      parseInDocument(request, text),
    );
  };
  return { session, questions, send };
}

describe('runElasticRequest (V7.8)', () => {
  it('sends a read at once, with its body, kind and time limit', async () => {
    const { send, session, questions } = setup({ readOnly: true, production: true });
    const result = await send('POST /products/_search\n{ "size": 1 }', 5000);
    expect(result).toMatchObject({ kind: 'done', tookMs: 4, response: { status: 200 } });
    expect(session.requests).toEqual(['POST /products/_search {"size":1}']);
    expect(questions).toEqual([]);
    await send('POST /_msearch\n{}\n{}');
    expect(session.requests[1]).toBe('POST /_msearch {}\n{}\n');
  });

  it('refuses every write on a read-only connection, before it is sent', async () => {
    const { send, session } = setup({ readOnly: true });
    for (const text of ['PUT /items', 'POST /items/_doc\n{}', 'DELETE /items', 'POST /_bulk\n{}']) {
      await expect(send(text)).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'Read-only',
      });
    }
    expect(session.requests).toEqual([]);
  });

  it('asks once before a write on production, and stops on no', async () => {
    const yes = setup({ production: true });
    await yes.send('PUT /items/_doc/1\n{}');
    expect(yes.questions).toEqual([
      { kind: 'production', request: 'PUT /items/_doc/1', production: true },
    ]);
    const no = setup({ production: true, answer: false });
    expect(await no.send('PUT /items')).toEqual({ kind: 'cancelled' });
    expect(no.session.requests).toEqual([]);
  });

  it('asks before a dangerous request in safe mode, blocks it in block, lets it by when off', async () => {
    const asked = setup();
    await asked.send('DELETE /products');
    expect(asked.questions).toEqual([
      { kind: 'dangerous', request: 'DELETE /products', production: false },
    ]);
    const blocked = setup({ safeMode: 'block' });
    await expect(
      blocked.send('POST /products/_delete_by_query\n{"query":{"match_all":{}}}'),
    ).rejects.toMatchObject({
      message: 'Blocked',
    });
    expect((await blocked.send('PUT /items')).kind).toBe('done');
    const off = setup({ safeMode: 'off' });
    await off.send('DELETE /products');
    expect(off.questions).toEqual([]);
    const production = setup({ production: true });
    await production.send('DELETE /products');
    expect(production.questions).toEqual([
      { kind: 'dangerous', request: 'DELETE /products', production: true },
    ]);
  });

  it('says where in the document a body is not JSON', () => {
    const text = 'GET /a\n\nPOST /b/_search\n{ "size": }';
    const [, second] = splitRequests(text);
    if (second === undefined) {
      throw new Error('no request');
    }
    expect(() => parseInDocument(second, text)).toThrow(
      expect.objectContaining({
        code: 'syntax',
        message: expect.stringMatching(/^4:\d+ Unexpected/) as unknown,
      }),
    );
  });
});

describe('requestTemplate (V7.8)', () => {
  it('searches the index a query was opened from, or looks at the cluster', () => {
    expect(requestTemplate('logs 1')).toBe(
      'GET /logs%201/_search\n{\n  "query": { "match_all": {} },\n  "size": 20\n}\n\nGET /logs%201/_mapping\n',
    );
    expect(requestTemplate(undefined)).toBe('GET /_cat/indices?v\n\nGET /_cluster/health\n');
  });
});
