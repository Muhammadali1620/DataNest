import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { authorizationOf, MAX_BODY_BYTES, readText } from '../../../../src/drivers/loki/http';

const URL_OF = new URL('http://localhost:3100');

describe('authorizationOf', () => {
  it('is basic authentication for a user with a password', () => {
    expect(authorizationOf({ url: URL_OF, user: 'ann', secret: 'pw' })).toBe(
      `Basic ${Buffer.from('ann:pw').toString('base64')}`,
    );
  });

  it('keeps the characters of a password that are not ASCII', () => {
    const header = authorizationOf({ url: URL_OF, user: 'ann', secret: 'pä:ß' });
    expect(Buffer.from((header ?? '').slice(6), 'base64').toString('utf8')).toBe('ann:pä:ß');
  });

  it('is a bearer token for a password without a user', () => {
    expect(authorizationOf({ url: URL_OF, secret: 'tok' })).toBe('Bearer tok');
    expect(authorizationOf({ url: URL_OF, user: '', secret: 'tok' })).toBe('Bearer tok');
  });

  it('is nothing without a password', () => {
    expect(authorizationOf({ url: URL_OF })).toBeUndefined();
    expect(authorizationOf({ url: URL_OF, user: 'ann' })).toBeUndefined();
    expect(authorizationOf({ url: URL_OF, user: 'ann', secret: '' })).toBeUndefined();
  });
});

describe('readText', () => {
  it('joins the chunks and decodes them as UTF-8, even across a character', async () => {
    const bytes = Buffer.from('héllo \u{1F600}', 'utf8');
    const body = Readable.from([bytes.subarray(0, 2), bytes.subarray(2)]);
    expect(await readText(body as AsyncIterable<Buffer>)).toBe('héllo \u{1F600}');
  });

  it('refuses an answer larger than the limit instead of cutting it', async () => {
    const body = Readable.from([Buffer.alloc(10), Buffer.alloc(10)]);
    await expect(readText(body as AsyncIterable<Buffer>, 15)).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('allows 64 MB by default', () => {
    expect(MAX_BODY_BYTES).toBe(64 * 1024 * 1024);
  });
});
