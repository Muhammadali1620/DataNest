import { describe, expect, it } from 'vitest';
import {
  type HttpCall,
  type HttpReply,
  safeLocation,
  TinyPng,
  type TinyTransport,
} from '../../../../src/services/tools/tinypng';
import { isTinyKey, isTinyMime, MAX_TINY_BYTES } from '../../../../src/shared/tools/tinypng';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

function transport(replies: (HttpReply | Error)[]): { send: TinyTransport; calls: HttpCall[] } {
  const calls: HttpCall[] = [];
  const queue = [...replies];
  return {
    calls,
    send: (call) => {
      calls.push(call);
      const next = queue.shift();
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(next ?? { status: 500, headers: {}, body: bytes() });
    },
  };
}

const created = (
  location = 'https://api.tinify.com/output/abc',
  extra: HttpReply['headers'] = {},
): HttpReply => ({
  status: 201,
  headers: { location, 'compression-count': '42', ...extra },
  body: bytes(),
});

describe('TinyPng', () => {
  it('shrinks in two calls: upload, then download the output', async () => {
    const { send, calls } = transport([
      created(),
      { status: 200, headers: {}, body: bytes(9, 8, 7) },
    ]);
    const result = await new TinyPng(send).compress('KEY12345', bytes(1, 2, 3), 'image/png');
    expect(result).toEqual({ ok: true, bytes: bytes(9, 8, 7), count: 42 });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/shrink' });
    expect(calls[0]?.headers['Content-Type']).toBe('image/png');
    expect(calls[0]?.body).toEqual(bytes(1, 2, 3));
    expect(calls[1]).toMatchObject({ method: 'GET', path: '/output/abc' });
    const auth = `Basic ${Buffer.from('api:KEY12345').toString('base64')}`;
    expect(calls[0]?.headers.Authorization).toBe(auth);
    expect(calls[1]?.headers.Authorization).toBe(auth);
  });

  it('reports the compression count only when TinyPNG sends one', async () => {
    const { send } = transport([
      created('https://api.tinify.com/output/x', { 'compression-count': 'many' }),
      { status: 200, headers: {}, body: bytes(1) },
    ]);
    expect(await new TinyPng(send).compress('KEY12345', bytes(1), 'image/jpeg')).toEqual({
      ok: true,
      bytes: bytes(1),
      count: undefined,
    });
  });

  it('maps the answers it knows to errors the page can explain', async () => {
    const cases: [number, string][] = [
      [401, 'unauthorized'],
      [429, 'limit'],
      [415, 'unsupported'],
      [400, 'unsupported'],
      [413, 'too-big'],
      [500, 'failed'],
      [503, 'failed'],
    ];
    for (const [status, error] of cases) {
      const { send } = transport([{ status, headers: {}, body: bytes() }]);
      expect(
        await new TinyPng(send).compress('KEY12345', bytes(1), 'image/png'),
        String(status),
      ).toEqual({ ok: false, error });
    }
  });

  it('maps a failed download too', async () => {
    const { send } = transport([created(), { status: 429, headers: {}, body: bytes() }]);
    expect(await new TinyPng(send).compress('KEY12345', bytes(1), 'image/png')).toEqual({
      ok: false,
      error: 'limit',
    });
  });

  it('says network when the connection fails, in either call', async () => {
    expect(
      await new TinyPng(transport([new Error('ECONNRESET')]).send).compress(
        'KEY12345',
        bytes(1),
        'image/png',
      ),
    ).toEqual({ ok: false, error: 'network' });
    expect(
      await new TinyPng(transport([created(), new Error('timeout')]).send).compress(
        'KEY12345',
        bytes(1),
        'image/png',
      ),
    ).toEqual({ ok: false, error: 'network' });
  });

  it('does not even call for an empty or too big picture', async () => {
    const { send, calls } = transport([]);
    expect(await new TinyPng(send).compress('KEY12345', bytes(), 'image/png')).toEqual({
      ok: false,
      error: 'unsupported',
    });
    expect(
      await new TinyPng(send).compress('KEY12345', new Uint8Array(MAX_TINY_BYTES + 1), 'image/png'),
    ).toEqual({ ok: false, error: 'too-big' });
    expect(calls).toHaveLength(0);
  });

  it('never follows a location outside api.tinify.com, so the key goes nowhere else', async () => {
    for (const location of [
      'https://evil.example/output/a',
      'http://api.tinify.com/output/a',
      'https://api.tinify.com.evil.example/o',
      'https://user@api.tinify.com/o',
      'https://api.tinify.com:8443/o',
      'not a url',
      undefined,
    ]) {
      const { send, calls } = transport([
        location === undefined ? { status: 201, headers: {}, body: bytes() } : created(location),
      ]);
      expect(
        await new TinyPng(send).compress('KEY12345', bytes(1), 'image/png'),
        String(location),
      ).toEqual({ ok: false, error: 'failed' });
      expect(calls).toHaveLength(1);
    }
  });

  it('reads a location that comes as a list', async () => {
    const { send, calls } = transport([
      created('', { location: ['https://api.tinify.com/output/z'] }),
      { status: 200, headers: {}, body: bytes(5) },
    ]);
    expect((await new TinyPng(send).compress('KEY12345', bytes(1), 'image/webp')).ok).toBe(true);
    expect(calls[1]?.path).toBe('/output/z');
  });
});

describe('safeLocation and keys', () => {
  it('returns the path and the query of an address on the TinyPNG host', () => {
    expect(safeLocation('https://api.tinify.com/output/a?b=1')).toBe('/output/a?b=1');
    expect(safeLocation('https://example.com/output/a')).toBeUndefined();
  });

  it('recognises a key and a format', () => {
    expect(isTinyKey('abcDEF12_-34')).toBe(true);
    expect(isTinyKey('short')).toBe(false);
    expect(isTinyKey('has space in it')).toBe(false);
    expect(isTinyKey('x'.repeat(201))).toBe(false);
    expect(isTinyMime('image/png')).toBe(true);
    expect(isTinyMime('image/gif')).toBe(false);
  });
});
