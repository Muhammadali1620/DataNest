// What an Elasticsearch driver offers (V7.8): HTTP requests to a cluster, answered with
// the status and the body as the server wrote it — JSON text, so that numbers keep every
// digit (D24, D91). Not a SQL driver (D81); OpenSearch speaks the same API.

import type { ResolvedConnectionConfig } from '../shared/connection';

/** What the cluster said about itself when the session opened (`GET /`). */
export interface ElasticServerInfo {
  /** `8.19.6`. */
  readonly version: string;
  readonly distribution: 'elasticsearch' | 'opensearch';
  readonly clusterName: string;
}

export interface ElasticRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'HEAD' | 'PATCH';
  /** The path with its query: `/products/_search?size=5`. */
  readonly path: string;
  readonly body?: string;
  /** NDJSON for `_bulk` and `_msearch`; JSON otherwise. */
  readonly ndjson?: boolean;
  /** Milliseconds to wait for the answer; 0 or absent: no limit. */
  readonly timeoutMs?: number;
}

export interface ElasticResponse {
  readonly status: number;
  /** The body as text; empty for HEAD. */
  readonly body: string;
  readonly contentType: string;
}

/** One live connection: a keep-alive agent and the cluster it talks to. */
export interface ElasticSession {
  readonly server: ElasticServerInfo;
  /**
   * Sends a request; any HTTP status resolves, the caller reads it. A lost or refused
   * link rejects with code `connection-failed` (D26), a timeout with `timeout`.
   */
  request(request: ElasticRequest): Promise<ElasticResponse>;
  close(): Promise<void>;
}

export interface ElasticDriver {
  readonly id: 'elasticsearch';
  openSession(config: ResolvedConnectionConfig): Promise<ElasticSession>;
}

/** The shape of the lazily loaded bundle dist/drivers/elasticsearch.js. */
export interface ElasticDriverModule {
  readonly driver: ElasticDriver;
}
