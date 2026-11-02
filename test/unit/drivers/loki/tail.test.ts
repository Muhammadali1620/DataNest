import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { agentFor, targetUrl } from '../../../../src/drivers/loki/http';
import type { LokiTarget } from '../../../../src/drivers/loki/http';
import {
  acceptKey,
  encodeFrame,
  FrameParser,
  MAX_FRAME_BYTES,
  OPCODE,
  tailMessages,
} from '../../../../src/drivers/loki/tail';
import { readTailMessage } from '../../../../src/drivers/loki/values';
import { FakeLoki, serverFrame } from '../../../helpers/fake-loki';

/** Reads a stream of messages to the end; what it brings does not matter, only how it ends. */
async function drain(source: AsyncIterable<string>): Promise<void> {
  for await (const text of source) {
    expect(typeof text).toBe('string');
  }
}

describe('FrameParser', () => {
  it('reads a short unmasked frame', () => {
    const frames = new FrameParser().push(serverFrame(OPCODE.text, Buffer.from('hello')));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.opcode).toBe(OPCODE.text);
    expect(frames[0]?.fin).toBe(true);
    expect(frames[0]?.payload.toString()).toBe('hello');
  });

  it('reads the 16-bit and the 64-bit length forms', () => {
    const middle = Buffer.alloc(300, 0x61);
    const long = Buffer.alloc(70_000, 0x62);
    const frames = new FrameParser().push(
      Buffer.concat([serverFrame(OPCODE.text, middle), serverFrame(OPCODE.text, long)]),
    );
    expect(frames.map((frame) => frame.payload.length)).toEqual([300, 70_000]);
  });

  it('waits for the rest of a frame that arrives in pieces', () => {
    const parser = new FrameParser();
    const whole = serverFrame(OPCODE.text, Buffer.from('in pieces'));
    expect(parser.push(whole.subarray(0, 1))).toEqual([]);
    expect(parser.push(whole.subarray(1, 4))).toEqual([]);
    const frames = parser.push(whole.subarray(4));
    expect(frames.map((frame) => frame.payload.toString())).toEqual(['in pieces']);
  });

  it('waits for a long header cut in two', () => {
    const parser = new FrameParser();
    const whole = serverFrame(OPCODE.text, Buffer.alloc(300, 1));
    expect(parser.push(whole.subarray(0, 3))).toEqual([]);
    expect(parser.push(whole.subarray(3))).toHaveLength(1);
    const wide = serverFrame(OPCODE.text, Buffer.alloc(70_000, 1));
    expect(parser.push(wide.subarray(0, 9))).toEqual([]);
    expect(parser.push(wide.subarray(9))).toHaveLength(1);
  });

  it('unmasks a masked frame', () => {
    const frames = new FrameParser().push(encodeFrame(OPCODE.text, Buffer.from('masked text')));
    expect(frames[0]?.payload.toString()).toBe('masked text');
  });

  it('keeps the fin bit of a fragment', () => {
    const frames = new FrameParser().push(
      Buffer.concat([
        serverFrame(OPCODE.text, Buffer.from('a'), false),
        serverFrame(OPCODE.continuation, Buffer.from('b'), true),
      ]),
    );
    expect(frames.map((frame) => frame.fin)).toEqual([false, true]);
  });

  it('refuses a frame past the limit', () => {
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(MAX_FRAME_BYTES) + 1n, 2);
    expect(() => new FrameParser().push(header)).toThrow(DbError);
  });
});

describe('encodeFrame', () => {
  it('masks the payload and sets the fin bit', () => {
    const frame = encodeFrame(OPCODE.pong, Buffer.from('x'));
    expect(frame[0]).toBe(0x8a);
    expect((frame[1] ?? 0) & 0x80).toBe(0x80);
    expect(frame.length).toBe(2 + 4 + 1);
  });

  it('uses the longer length forms', () => {
    expect(encodeFrame(OPCODE.text, Buffer.alloc(200))[1]).toBe(0x80 | 126);
    expect(encodeFrame(OPCODE.text, Buffer.alloc(70_000))[1]).toBe(0x80 | 127);
  });
});

describe('acceptKey', () => {
  it('matches the example of RFC 6455', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });
});

describe('tailMessages', () => {
  let server: FakeLoki;
  const agents: ReturnType<typeof agentFor>[] = [];

  beforeEach(async () => {
    server = new FakeLoki();
    await server.start();
  });

  afterEach(async () => {
    for (const agent of agents.splice(0)) {
      agent.destroy();
    }
    await server.stop();
  });

  function target(over: Partial<LokiTarget> = {}): LokiTarget {
    return { url: targetUrl('127.0.0.1', server.port, false), ...over };
  }

  async function read(
    over: Partial<LokiTarget> = {},
    signal: AbortSignal = new AbortController().signal,
    limit = Number.POSITIVE_INFINITY,
  ): Promise<string[]> {
    const used = target(over);
    const agent = agentFor(used.url, undefined);
    agents.push(agent);
    const texts: string[] = [];
    for await (const text of tailMessages(used, agent, { query: '{app="shop"}' }, signal)) {
      texts.push(text);
      if (texts.length >= limit) {
        break;
      }
    }
    return texts;
  }

  it('gives the messages in order and ends when the server closes', async () => {
    server.tailScript = { messages: ['{"n":1}', '{"n":2}'], close: true };
    expect(await read()).toEqual(['{"n":1}', '{"n":2}']);
    expect(server.calls('/loki/api/v1/tail')[0]?.query.query).toBe('{app="shop"}');
  });

  it('joins a message sent in fragments', async () => {
    server.tailScript = { messages: ['{"streams":[]}', '{"n":2}'], close: true, fragment: true };
    expect(await read()).toEqual(['{"streams":[]}', '{"n":2}']);
  });

  it('answers a ping with a pong and says goodbye with a close', async () => {
    server.tailScript = { messages: ['{"n":1}'], close: true, ping: true };
    await read();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.clientFrames.some((frame) => frame.opcode === OPCODE.pong)).toBe(true);
    expect(
      server.clientFrames.find((frame) => frame.opcode === OPCODE.pong)?.payload.toString(),
    ).toBe('hi');
  });

  it('stops quietly when the caller aborts', async () => {
    server.tailScript = { messages: ['{"n":1}'] };
    const controller = new AbortController();
    const texts: string[] = [];
    const used = target();
    const agent = agentFor(used.url, undefined);
    agents.push(agent);
    for await (const text of tailMessages(used, agent, { query: 'q' }, controller.signal)) {
      texts.push(text);
      controller.abort();
    }
    expect(texts).toEqual(['{"n":1}']);
  });

  it('ends at once when it was aborted before it started', async () => {
    server.tailScript = { messages: ['{"n":1}'] };
    const controller = new AbortController();
    controller.abort();
    expect(await read({}, controller.signal)).toEqual([]);
  });

  it('stops when the caller leaves the loop', async () => {
    server.tailScript = { messages: ['{"n":1}', '{"n":2}', '{"n":3}'], intervalMs: 5 };
    expect(await read({}, undefined, 1)).toEqual(['{"n":1}']);
  });

  it('sends the credentials and the tenant', async () => {
    server.tailScript = { messages: [], close: true };
    await read({ user: 'u', secret: 'p', tenant: 'team' });
    const call = server.calls('/loki/api/v1/tail')[0];
    expect(call?.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    expect(call?.tenant).toBe('team');
  });

  it('sends a bearer token when only a secret is set', async () => {
    server.tailScript = { messages: [], close: true };
    await read({ secret: 'tok' });
    expect(server.calls('/loki/api/v1/tail')[0]?.authorization).toBe('Bearer tok');
  });

  it('turns a refusal into an error with the server’s words', async () => {
    server.tailScript = { messages: [], refuse: { status: 400, body: 'parse error at 1:1' } };
    await expect(read()).rejects.toMatchObject({ code: 'syntax', message: 'parse error at 1:1' });
  });

  it('turns a bad login into an auth error', async () => {
    const guarded = new FakeLoki({ authorization: 'Bearer right' });
    await guarded.start();
    guarded.tailScript = { messages: [] };
    const used: LokiTarget = {
      url: targetUrl('127.0.0.1', guarded.port, false),
      secret: 'wrong',
    };
    const agent = agentFor(used.url, undefined);
    try {
      await expect(
        drain(tailMessages(used, agent, { query: 'q' }, new AbortController().signal)),
      ).rejects.toMatchObject({ code: 'auth-failed' });
    } finally {
      agent.destroy();
      await guarded.stop();
    }
  });

  it('reports a server without the endpoint', async () => {
    await expect(read()).rejects.toMatchObject({ code: 'not-found' });
  });

  it('reports a connection that cannot be made', async () => {
    const used: LokiTarget = { url: targetUrl('127.0.0.1', 1, false) };
    const agent = agentFor(used.url, undefined);
    try {
      await expect(
        drain(tailMessages(used, agent, { query: 'q' }, new AbortController().signal)),
      ).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      agent.destroy();
    }
  });
});

describe('readTailMessage', () => {
  it('turns the streams of a message into rows, oldest first', () => {
    const batch = readTailMessage(
      JSON.stringify({
        streams: [
          { stream: { app: 'shop' }, values: [['1730000000000000003', 'three']] },
          {
            stream: { app: 'api' },
            values: [
              ['1730000000000000001', 'one'],
              ['1730000000000000002', 'two'],
            ],
          },
        ],
      }),
    );
    expect(batch.rows.map((row) => row[3])).toEqual(['one', 'two', 'three']);
    expect(batch.dropped).toBe(0);
  });

  it('counts the lines Loki dropped', () => {
    const batch = readTailMessage(
      JSON.stringify({
        streams: [],
        dropped_entries: [
          { labels: {}, timestamp: '1' },
          { labels: {}, timestamp: '2' },
        ],
      }),
    );
    expect(batch).toEqual({ rows: [], dropped: 2 });
  });

  it('skips a malformed entry and a message without streams', () => {
    expect(readTailMessage('{}')).toEqual({ rows: [], dropped: 0 });
    const batch = readTailMessage(
      JSON.stringify({ streams: [{ stream: {}, values: [['x', 'bad'], 7] }, 5] }),
    );
    expect(batch.rows).toEqual([]);
  });

  it('refuses text that is not JSON', () => {
    expect(() => readTailMessage('nope')).toThrow(DbError);
    expect(() => readTailMessage('[1]')).toThrow(DbError);
  });
});
