// The calls of Loki's HTTP API that answer with a JSON document: the labels, the values of a
// label, a query. Shared by the session (queries) and the metadata reader (the tree).

import type { Agent as HttpAgent } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import { fromHttpStatus } from './errors';
import { type LokiTarget, readText, send } from './http';

export class LokiApi {
  constructor(
    readonly target: LokiTarget,
    private readonly agent: HttpAgent | HttpsAgent,
  ) {}

  /** The text of a successful answer; an error status becomes an error of ours. */
  async text(
    path: string,
    query: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await send(this.target, this.agent, {
      path,
      query,
      ...(signal === undefined ? {} : { signal }),
    });
    const body = await readText(response.body);
    if (response.status >= 400) {
      throw fromHttpStatus(response.status, body);
    }
    return body;
  }

  /** The `data` array of the labels and label-values calls. */
  async list(
    path: string,
    query: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const parsed: unknown = JSON.parse(await this.text(path, query, signal));
    const data = (parsed as { data?: unknown } | null)?.data;
    return Array.isArray(data)
      ? data.filter((item): item is string => typeof item === 'string')
      : [];
  }
}
