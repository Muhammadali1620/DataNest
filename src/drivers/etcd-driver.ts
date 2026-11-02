// What an etcd driver offers (V13.19): calls to the cluster's HTTP/JSON gateway
// (`POST /v3/kv/range` and the like), answered with the parsed JSON. Not a SQL driver
// (D81). The gateway writes the 64-bit numbers as strings and the bytes as base64, so
// the JSON loses nothing when parsed; turning them into values is the service's job.

import type { ResolvedConnectionConfig } from '../shared/connection';

/** What the cluster said about itself when the session opened (`/v3/maintenance/status`). */
export interface EtcdServerInfo {
  /** `3.5.17`. */
  readonly version: string;
  /** The id of the cluster, as the gateway writes it (a decimal number). */
  readonly clusterId: string;
  /** Bytes the member's database takes; 0 when it did not say. */
  readonly dbSizeBytes: number;
  /** True when authentication is on and the session signed in. */
  readonly authenticated: boolean;
}

export interface EtcdCallOptions {
  /** Milliseconds to wait for the answer; 0 or absent: no limit. */
  readonly timeoutMs?: number;
}

/** One live connection: a keep-alive agent, the auth token and the cluster it talks to. */
export interface EtcdSession {
  readonly server: EtcdServerInfo;
  /**
   * Posts `body` to a gateway path below the version (`kv/range`, `lease/grant`) and
   * returns the answer. A refusal rejects with the error kind the cluster's status code
   * stands for; a lost link with `connection-failed`, a timeout with `timeout`. An
   * expired auth token is renewed once, silently.
   */
  call(
    path: string,
    body: Readonly<Record<string, unknown>>,
    options?: EtcdCallOptions,
  ): Promise<unknown>;
  /**
   * Opens a streaming call (`watch`, V13.31): posts `body` and hands every JSON message
   * the cluster writes back — one per line — to `onMessage`, until `signal` aborts (the
   * promise then resolves), the cluster ends the stream (it resolves too), or the link
   * or the cluster fails (it rejects). A stream is not subject to a time limit.
   */
  watch(
    path: string,
    body: Readonly<Record<string, unknown>>,
    onMessage: (message: unknown) => void,
    signal: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface EtcdDriver {
  readonly id: 'etcd';
  openSession(config: ResolvedConnectionConfig): Promise<EtcdSession>;
}

/** The shape of the lazily loaded bundle dist/drivers/etcd.js. */
export interface EtcdDriverModule {
  readonly driver: EtcdDriver;
}
