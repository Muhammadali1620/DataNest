// The live view of a LogQL query (V13.27). Loki's tail endpoint is a WebSocket, and a small
// reader of WebSocket frames is all it takes: the handshake is an HTTP request with an upgrade,
// and the server sends text frames of JSON, one per batch of new lines. Written from RFC 6455
// (clean-room); no library, no native code.

import { createHash, randomBytes } from 'node:crypto';
import type { Agent as HttpAgent } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import { request as httpsRequest } from 'node:https';
import type { Duplex } from 'node:stream';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import { fromHttpStatus } from './errors';
import { authorizationOf, type LokiTarget, readText } from './http';

/** The GUID every WebSocket handshake hashes with the client's key (RFC 6455, 1.3). */
const HANDSHAKE_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** The largest frame that is read; a batch of lines is far smaller. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

function tooLarge(): DbError {
  return new DbError('unsupported', msg('The server sent a message that is too large'));
}

/** Cuts a stream of bytes into frames; a frame that has not fully arrived waits for the rest. */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.next();
      if (frame === undefined) {
        return frames;
      }
      frames.push(frame);
    }
  }

  private next(): Frame | undefined {
    const bytes = this.buffer;
    if (bytes.length < 2) {
      return undefined;
    }
    const first = bytes[0] ?? 0;
    const second = bytes[1] ?? 0;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (bytes.length < 4) {
        return undefined;
      }
      length = bytes.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (bytes.length < 10) {
        return undefined;
      }
      const wide = bytes.readBigUInt64BE(2);
      if (wide > BigInt(MAX_FRAME_BYTES)) {
        throw tooLarge();
      }
      length = Number(wide);
      offset = 10;
    }
    if (length > MAX_FRAME_BYTES) {
      throw tooLarge();
    }
    const maskLength = masked ? 4 : 0;
    const end = offset + maskLength + length;
    if (bytes.length < end) {
      return undefined;
    }
    const payload = Buffer.from(bytes.subarray(offset + maskLength, end));
    if (masked) {
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (bytes[offset + (index % 4)] ?? 0);
      }
    }
    this.buffer = Buffer.from(bytes.subarray(end));
    return { fin: (first & 0x80) !== 0, opcode: first & 0x0f, payload };
  }
}

/** A frame a client sends: always masked, as the protocol requires. */
export function encodeFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  let head: Buffer;
  if (length < 126) {
    head = Buffer.from([0x80 | opcode, 0x80 | length]);
  } else if (length < 65_536) {
    head = Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 0x80 | 127;
    head.writeBigUInt64BE(BigInt(length), 2);
  }
  const body = Buffer.from(payload);
  for (let index = 0; index < body.length; index += 1) {
    body[index] = (body[index] ?? 0) ^ (mask[index % 4] ?? 0);
  }
  return Buffer.concat([head, mask, body]);
}

/** The answer a server must give to a client's key. */
export function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + HANDSHAKE_GUID)
    .digest('base64');
}

interface Upgraded {
  readonly socket: Duplex;
  readonly head: Buffer;
}

function connect(
  target: LokiTarget,
  agent: HttpAgent | HttpsAgent,
  path: string,
  query: Readonly<Record<string, string>>,
  signal: AbortSignal,
): Promise<Upgraded> {
  return new Promise<Upgraded>((resolve, reject) => {
    const url = new URL(target.url);
    url.pathname = path;
    url.search = new URLSearchParams(query).toString();
    const key = randomBytes(16).toString('base64');
    const authorization = authorizationOf(target);
    const open = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = open(url, {
      agent,
      signal,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': key,
        ...(authorization === undefined ? {} : { authorization }),
        ...(target.tenant === undefined || target.tenant === ''
          ? {}
          : { 'x-scope-orgid': target.tenant }),
      },
    });
    request.on('upgrade', (response, socket, head) => {
      if (response.headers['sec-websocket-accept'] !== acceptKey(key)) {
        socket.destroy();
        reject(new DbError('connection-failed', msg('The server did not accept the live view')));
        return;
      }
      resolve({ socket, head });
    });
    // Any other answer means the server refused: an error status, with its words.
    request.on('response', (response) => {
      response.on('error', () => undefined);
      readText(response).then(
        (body) => {
          reject(fromHttpStatus(response.statusCode ?? 0, body));
        },
        (error: unknown) => {
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * The text messages Loki sends for a query, as they come. The stream ends when the server
 * closes it or when `signal` is aborted (the caller's way to stop); a refusal is an error.
 */
export async function* tailMessages(
  target: LokiTarget,
  agent: HttpAgent | HttpsAgent,
  query: Readonly<Record<string, string>>,
  signal: AbortSignal,
): AsyncGenerator<string> {
  let connection: Upgraded;
  try {
    connection = await connect(target, agent, '/loki/api/v1/tail', query, signal);
  } catch (error) {
    if (signal.aborted) {
      return;
    }
    throw error;
  }
  const { socket, head } = connection;
  const stop = (): void => {
    socket.destroy();
  };
  signal.addEventListener('abort', stop, { once: true });
  socket.on('error', () => undefined);
  const parser = new FrameParser();
  let pieces: Buffer[] = [];
  const chunks = async function* (): AsyncGenerator<Buffer> {
    if (head.length > 0) {
      yield head;
    }
    for await (const chunk of socket) {
      yield chunk as Buffer;
    }
  };
  try {
    for await (const chunk of chunks()) {
      for (const frame of parser.push(chunk)) {
        if (frame.opcode === OPCODE.ping) {
          socket.write(encodeFrame(OPCODE.pong, frame.payload));
        } else if (frame.opcode === OPCODE.close) {
          return;
        } else if (frame.opcode === OPCODE.text || frame.opcode === OPCODE.continuation) {
          pieces.push(frame.payload);
          if (frame.fin) {
            const text = Buffer.concat(pieces).toString('utf8');
            pieces = [];
            yield text;
          }
        }
      }
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  } finally {
    signal.removeEventListener('abort', stop);
    if (!socket.destroyed) {
      socket.write(encodeFrame(OPCODE.close));
      socket.destroy();
    }
  }
}
