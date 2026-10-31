// "Copy as cURL" and "Show Settings" (V10.2.7) against a real Elasticsearch node: the
// copied command runs in a shell and gets what DataNest gets.

import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRequest, splitRequests } from '../../../src/core/elastic/requests';
import { jsonString, member, parseJson } from '../../../src/core/json/json-tree';
import { driver } from '../../../src/drivers/elasticsearch';
import type { ElasticSession } from '../../../src/drivers/elastic-driver';
import { callJson } from '../../../src/services/elasticsearch/catalog';
import { curlCommand } from '../../../src/services/elasticsearch/curl';
import type { ConnectionConfig } from '../../../src/shared/connection';
import { TEST_ELASTIC } from '../../helpers/elastic-servers';

const INDEX = 'datanest_it_curl';
const config: ConnectionConfig = {
  id: 'curl',
  name: 'curl',
  driver: 'elasticsearch',
  host: TEST_ELASTIC.host,
  port: TEST_ELASTIC.port,
  user: TEST_ELASTIC.user.name,
  elastic: { auth: 'basic' },
};
let session: ElasticSession;

/** Runs a copied command; the password is added the way a person would type it. */
function run(command: string): string {
  return execFileSync(
    'sh',
    ['-c', `${command} -s -u '${TEST_ELASTIC.user.name}:${TEST_ELASTIC.user.password}'`],
    {
      encoding: 'utf8',
    },
  );
}

function copied(text: string): string {
  const [request] = splitRequests(text);
  if (request === undefined) {
    throw new Error('no request');
  }
  return curlCommand(parseRequest(request, text), config);
}

beforeAll(async () => {
  session = await driver.openSession({ ...config, password: TEST_ELASTIC.user.password });
  await session.request({ method: 'DELETE', path: `/${INDEX}` });
  await session.request({
    method: 'PUT',
    path: `/${INDEX}`,
    body: '{"settings":{"number_of_replicas":0}}',
  });
});

afterAll(async () => {
  await session.request({ method: 'DELETE', path: `/${INDEX}` });
  await session.close();
});

describe.runIf(process.platform !== 'win32')('Copy as cURL on a real node', () => {
  it('sends a request with a JSON body that holds a quote', () => {
    run(copied(`POST /${INDEX}/_doc?refresh=true\n{ "name": "it's a lamp" }`));
    const found = parseJson(
      run(copied(`GET /${INDEX}/_search\n{ "query": { "match": { "name": "lamp" } } }`)),
    );
    expect(jsonString(member(member(member(found, 'hits'), 'total'), 'relation'))).toBe('eq');
    expect(JSON.stringify(found)).toContain("it's a lamp");
  });

  it('sends NDJSON to _bulk', () => {
    const answer = parseJson(
      run(
        copied(
          `POST /${INDEX}/_bulk?refresh=true\n{"index":{}}\n{"name":"one"}\n{"index":{}}\n{"name":"two"}`,
        ),
      ),
    );
    expect(member(answer, 'errors')).toEqual({ type: 'bool', value: false });
  });
});

describe('Show Settings on a real node', () => {
  it('reads the settings of an index', async () => {
    const settings = await callJson(session, { method: 'GET', path: `/${INDEX}/_settings` });
    expect(
      jsonString(
        member(member(member(member(settings, INDEX), 'settings'), 'index'), 'number_of_replicas'),
      ),
    ).toBe('0');
  });
});
