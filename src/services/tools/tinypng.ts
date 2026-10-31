// The one place where the Tools page talks to the internet about pictures: TinyPNG's
// documented "shrink" call, made from the host with the user's own key, only when the user
// presses Compress. The key goes only to api.tinify.com.

import { request as httpsRequest } from 'node:https';
import { MAX_TINY_BYTES, type TinyError, type TinyMime } from '../../shared/tools/tinypng';

export interface HttpReply {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: Uint8Array;
}

export interface HttpCall {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

/** Sends a call to api.tinify.com; rejects on a network failure. */
export type TinyTransport = (call: HttpCall) => Promise<HttpReply>;

export const TINY_HOST = 'api.tinify.com';
const MAX_REPLY_BYTES = 40 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

export const nodeTransport: TinyTransport = (call) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: TINY_HOST,
        path: call.path,
        method: call.method,
        headers: {
          ...call.headers,
          ...(call.body === undefined ? {} : { 'Content-Length': call.body.length }),
        },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const parts: Buffer[] = [];
        let size = 0;
        res.on('data', (part: Buffer) => {
          size += part.length;
          if (size > MAX_REPLY_BYTES) {
            req.destroy(new Error('The reply is too big'));
            return;
          }
          parts.push(part);
        });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(parts),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => {
      req.destroy(new Error('Timed out'));
    });
    req.on('error', reject);
    req.end(call.body === undefined ? undefined : Buffer.from(call.body));
  });

export type TinyResult =
  | { readonly ok: true; readonly bytes: Uint8Array; readonly count: number | undefined }
  | { readonly ok: false; readonly error: TinyError };

function failure(status: number): TinyError {
  if (status === 401) {
    return 'unauthorized';
  }
  if (status === 429) {
    return 'limit';
  }
  if (status === 413) {
    return 'too-big';
  }
  if (status === 415 || status === 400) {
    return 'unsupported';
  }
  return 'failed';
}

function header(reply: HttpReply, name: string): string | undefined {
  const value = reply.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export class TinyPng {
  constructor(private readonly transport: TinyTransport = nodeTransport) {}

  /** Shrinks one picture; `mime` is only checked by the caller, TinyPNG reads the bytes itself. */
  async compress(key: string, bytes: Uint8Array, mime: TinyMime): Promise<TinyResult> {
    if (bytes.length === 0) {
      return { ok: false, error: 'unsupported' };
    }
    if (bytes.length > MAX_TINY_BYTES) {
      return { ok: false, error: 'too-big' };
    }
    const auth = `Basic ${Buffer.from(`api:${key}`).toString('base64')}`;
    try {
      const shrink = await this.transport({
        method: 'POST',
        path: '/shrink',
        headers: { Authorization: auth, 'Content-Type': mime },
        body: bytes,
      });
      if (shrink.status !== 201) {
        return { ok: false, error: failure(shrink.status) };
      }
      const count = Number(header(shrink, 'compression-count'));
      const location = header(shrink, 'location');
      // The key is only ever sent to TinyPNG's own host.
      const url = location === undefined ? undefined : safeLocation(location);
      if (url === undefined) {
        return { ok: false, error: 'failed' };
      }
      const output = await this.transport({
        method: 'GET',
        path: url,
        headers: { Authorization: auth },
      });
      if (output.status !== 200) {
        return { ok: false, error: failure(output.status) };
      }
      return { ok: true, bytes: output.body, count: Number.isFinite(count) ? count : undefined };
    } catch {
      return { ok: false, error: 'network' };
    }
  }
}

/** The path of an `https://api.tinify.com/…` address; anything else is not followed. */
export function safeLocation(location: string): string | undefined {
  try {
    const url = new URL(location);
    return url.protocol === 'https:' &&
      url.hostname === TINY_HOST &&
      url.username === '' &&
      url.port === ''
      ? `${url.pathname}${url.search}`
      : undefined;
  } catch {
    return undefined;
  }
}
