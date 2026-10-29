// An Elasticsearch session for unit tests: requests are answered by a function and
// recorded as `METHOD path body`.

import { DbError } from '../../src/core/errors';
import type {
  ElasticDriver,
  ElasticRequest,
  ElasticResponse,
  ElasticServerInfo,
  ElasticSession,
} from '../../src/drivers/elastic-driver';
import type { ResolvedConnectionConfig } from '../../src/shared/connection';

export type FakeElasticAnswer = (request: ElasticRequest) => ElasticResponse | Error | undefined;

export function json(body: unknown, status = 200): ElasticResponse {
  return {
    status,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    contentType: 'application/json',
  };
}

export class FakeElasticSession implements ElasticSession {
  readonly requests: string[] = [];
  closed = false;

  constructor(
    private readonly answer: FakeElasticAnswer = () => json({ acknowledged: true }),
    readonly server: ElasticServerInfo = {
      version: '8.19.6',
      distribution: 'elasticsearch',
      clusterName: 'c',
    },
  ) {}

  async request(request: ElasticRequest): Promise<ElasticResponse> {
    this.requests.push(
      `${request.method} ${request.path}${request.body === undefined ? '' : ` ${request.body}`}`,
    );
    if (this.closed) {
      throw new DbError('connection-failed', 'The session is closed');
    }
    const answer = this.answer(request);
    if (answer instanceof Error) {
      throw answer;
    }
    return await Promise.resolve(answer ?? json({}));
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.resolve();
  }
}

export class FakeElasticDriver implements ElasticDriver {
  readonly id = 'elasticsearch' as const;
  readonly configs: ResolvedConnectionConfig[] = [];
  readonly sessions: FakeElasticSession[] = [];
  failure: Error | undefined;

  constructor(private readonly make: () => FakeElasticSession = () => new FakeElasticSession()) {}

  async openSession(config: ResolvedConnectionConfig): Promise<ElasticSession> {
    this.configs.push(config);
    if (this.failure !== undefined) {
      throw this.failure;
    }
    const session = this.make();
    this.sessions.push(session);
    return await Promise.resolve(session);
  }
}
