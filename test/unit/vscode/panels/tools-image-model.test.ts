import { describe, expect, it, vi } from 'vitest';
import { TinyPng } from '../../../../src/services/tools/tinypng';
import {
  ImageTools,
  linkOf,
  type SecretsLike,
  TINY_KEY_SECRET,
} from '../../../../src/vscode/panels/tools-image-model';

function secrets(
  initial: Record<string, string> = {},
): SecretsLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    get: (key) => Promise.resolve(data[key]),
    store: (key, value) => {
      data[key] = value;
      return Promise.resolve();
    },
    delete: (key) => {
      Reflect.deleteProperty(data, key);
      return Promise.resolve();
    },
  };
}

function tools(
  store: SecretsLike | undefined,
  tiny?: TinyPng,
  open = vi.fn(() => Promise.resolve(true)),
): ImageTools {
  return new ImageTools({
    secrets: store,
    ...(tiny === undefined ? {} : { tiny }),
    openLink: open,
  });
}

describe('the TinyPNG key', () => {
  it('stores a valid key in the secrets and reports it saved, never returning it', async () => {
    const store = secrets();
    const model = tools(store);
    expect(await model.tinyStatus()).toEqual({ saved: false });
    expect(await model.tinySaveKey({ key: '  abcd1234efgh  ' })).toEqual({ ok: true });
    expect(store.data[TINY_KEY_SECRET]).toBe('abcd1234efgh');
    expect(await model.tinyStatus()).toEqual({ saved: true });
    expect(await model.tinyForgetKey()).toEqual({ ok: true });
    expect(await model.tinyStatus()).toEqual({ saved: false });
  });

  it('refuses a key that is not a key, and any key without secret storage', async () => {
    const store = secrets();
    expect(await tools(store).tinySaveKey({ key: 'no spaces allowed here' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await tools(store).tinySaveKey({ key: '' })).toEqual({ ok: false, error: 'invalid' });
    expect(store.data).toEqual({});
    expect(await tools(undefined).tinySaveKey({ key: 'abcd1234efgh' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await tools(undefined).tinyStatus()).toEqual({ saved: false });
    expect(await tools(undefined).tinyForgetKey()).toEqual({ ok: true });
  });
});

describe('tinyCompress', () => {
  it('needs a key first', async () => {
    expect(await tools(secrets()).tinyCompress({ base64: 'AQID', mime: 'image/png' })).toEqual({
      ok: false,
      error: 'no-key',
    });
  });

  it('sends the stored key and returns the smaller picture as Base64', async () => {
    const calls: string[] = [];
    const tiny = new TinyPng((call) => {
      calls.push(`${call.method} ${call.path} ${call.headers.Authorization ?? ''}`);
      return Promise.resolve(
        call.method === 'POST'
          ? {
              status: 201,
              headers: { location: 'https://api.tinify.com/output/q', 'compression-count': '3' },
              body: new Uint8Array(),
            }
          : { status: 200, headers: {}, body: Uint8Array.from([7, 7]) },
      );
    });
    const model = tools(secrets({ [TINY_KEY_SECRET]: 'abcd1234efgh' }), tiny);
    expect(await model.tinyCompress({ base64: 'AQID', mime: 'image/png' })).toEqual({
      ok: true,
      base64: 'Bwc=',
      count: 3,
    });
    expect(calls[0]).toContain(Buffer.from('api:abcd1234efgh').toString('base64'));
  });

  it("passes TinyPNG's refusal on and rejects Base64 that is not Base64", async () => {
    const tiny = new TinyPng(() =>
      Promise.resolve({ status: 401, headers: {}, body: new Uint8Array() }),
    );
    const model = tools(secrets({ [TINY_KEY_SECRET]: 'abcd1234efgh' }), tiny);
    expect(await model.tinyCompress({ base64: 'AQID', mime: 'image/png' })).toEqual({
      ok: false,
      error: 'unauthorized',
    });
    expect(await model.tinyCompress({ base64: '***', mime: 'image/png' })).toEqual({
      ok: false,
      error: 'unsupported',
    });
  });
});

describe('openLink', () => {
  it('opens web and mail links once the user agrees', async () => {
    const open = vi.fn(() => Promise.resolve(true));
    const model = tools(undefined, undefined, open);
    expect(await model.openLink({ url: 'https://example.com/a?b=1' })).toEqual({ opened: true });
    expect(await model.openLink({ url: 'mailto:me@example.com' })).toEqual({ opened: true });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('reports a link the user declined', async () => {
    const model = tools(
      undefined,
      undefined,
      vi.fn(() => Promise.resolve(false)),
    );
    expect(await model.openLink({ url: 'https://example.com' })).toEqual({ opened: false });
  });

  it('never asks about, or opens, anything else', async () => {
    const open = vi.fn(() => Promise.resolve(true));
    const model = tools(undefined, undefined, open);
    for (const url of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'vscode://x/y',
      'data:text/html,x',
      'not a link',
      'command:workbench.action.reload',
    ]) {
      expect(await model.openLink({ url }), url).toEqual({ opened: false });
    }
    expect(open).not.toHaveBeenCalled();
    expect(linkOf('https://example.com')?.hostname).toBe('example.com');
    expect(linkOf('ftp://example.com')).toBeUndefined();
  });
});
