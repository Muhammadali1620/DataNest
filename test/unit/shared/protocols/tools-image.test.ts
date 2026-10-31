import { describe, expect, it } from 'vitest';
import { toolsProtocol } from '../../../../src/shared/protocols/tools';
import { MAX_TINY_BASE64, TINY_ERRORS, TINY_MIMES } from '../../../../src/shared/tools/tinypng';

const host = toolsProtocol.host;

describe('the picture and QR requests of the Tools protocol', () => {
  it('asks for the state of the key and never answers with the key', () => {
    expect(host.requests.tinyStatus.params.parse({})).toEqual({});
    expect(host.requests.tinyStatus.result.parse({ saved: true })).toEqual({ saved: true });
    expect(host.requests.tinySaveKey.params.parse({ key: 'abc' })).toEqual({ key: 'abc' });
    expect(host.requests.tinySaveKey.result.parse({ ok: false, error: 'invalid' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(() => host.requests.tinySaveKey.result.parse({ ok: false, error: 'weird' })).toThrow();
    expect(() => host.requests.tinySaveKey.params.parse({ key: 'k'.repeat(301) })).toThrow();
    expect(host.requests.tinyForgetKey.result.parse({ ok: true })).toEqual({ ok: true });
  });

  it('takes only the formats TinyPNG takes, and no more than it takes', () => {
    for (const mime of TINY_MIMES) {
      expect(host.requests.tinyCompress.params.parse({ base64: 'AAAA', mime })).toBeTruthy();
    }
    expect(() =>
      host.requests.tinyCompress.params.parse({ base64: 'AAAA', mime: 'image/gif' }),
    ).toThrow();
    expect(() =>
      host.requests.tinyCompress.params.parse({
        base64: 'A'.repeat(MAX_TINY_BASE64 + 1),
        mime: 'image/png',
      }),
    ).toThrow();
  });

  it('answers a compression with a picture or one of the known errors', () => {
    expect(host.requests.tinyCompress.result.parse({ ok: true, base64: 'AQ==', count: 3 })).toEqual(
      {
        ok: true,
        base64: 'AQ==',
        count: 3,
      },
    );
    for (const error of TINY_ERRORS) {
      expect(host.requests.tinyCompress.result.parse({ ok: false, error })).toEqual({
        ok: false,
        error,
      });
    }
    expect(() => host.requests.tinyCompress.result.parse({ ok: false, error: 'weird' })).toThrow();
    expect(() => host.requests.tinyCompress.result.parse({ ok: true, count: -1 })).toThrow();
  });

  it('opens a link only when asked with one, of a sane length', () => {
    expect(host.requests.openLink.params.parse({ url: 'https://example.com' })).toBeTruthy();
    expect(() => host.requests.openLink.params.parse({ url: '' })).toThrow();
    expect(() => host.requests.openLink.params.parse({ url: 'x'.repeat(2001) })).toThrow();
    expect(host.requests.openLink.result.parse({ opened: false })).toEqual({ opened: false });
  });
});
