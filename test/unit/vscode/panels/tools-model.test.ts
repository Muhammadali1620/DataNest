import { describe, expect, it, vi } from 'vitest';
import { NetworkTools } from '../../../../src/services/tools/network';
import { safeFileName, ToolsModel } from '../../../../src/vscode/panels/tools-model';

type Outcome = 'saved' | 'cancelled' | 'failed';

function model(save = vi.fn((..._args: unknown[]): Promise<Outcome> => Promise.resolve('saved'))) {
  const network = new NetworkTools({
    connect: () => Promise.resolve({ ok: true, ms: 2 }),
    lookup: () => Promise.resolve([{ address: '10.0.0.1', family: 4 }]),
    interfaces: () => ({}),
    now: () => 0,
  });
  return { model: new ToolsModel({ network, save }), save };
}

describe('safeFileName', () => {
  it('keeps a plain name and sets the extension', () => {
    expect(safeFileName('picture', 'png')).toBe('picture.png');
    expect(safeFileName('picture.jpg', 'png')).toBe('picture.png');
  });

  it('removes folders, odd characters and leading dots', () => {
    expect(safeFileName('../../etc/passwd', 'txt')).toBe('_.._etc_passwd.txt');
    expect(safeFileName('a:b*c?.png', 'png')).toBe('a_b_c_.png');
    // A dot name is all extension, so nothing is left of the name.
    expect(safeFileName('.hidden', 'png')).toBe('file.png');
  });

  it('falls back to a name and an extension', () => {
    expect(safeFileName('', 'png')).toBe('file.png');
    expect(safeFileName('x', '??')).toBe('x.bin');
  });

  it('cuts a very long name', () => {
    expect(safeFileName('a'.repeat(500), 'png').length).toBeLessThanOrEqual(125);
  });
});

describe('ToolsModel', () => {
  it('hashes', () => {
    expect(model().model.hash({ text: 'abc' }).md5).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('lists interfaces, checks a port, resolves a name and pings', async () => {
    const { model: m } = model();
    const listed = m.interfaces();
    expect(listed.items).toEqual([]);
    expect(typeof listed.hostname).toBe('string');
    expect(await m.portCheck({ host: 'localhost', port: 80, timeoutMs: 500 })).toEqual({
      open: true,
      ms: 2,
    });
    expect(await m.dnsLookup({ host: 'x.test' })).toEqual({
      addresses: [{ address: '10.0.0.1', family: 4 }],
    });
    expect(
      (await m.tcpPing({ host: 'localhost', port: 80, count: 2, timeoutMs: 500 })).attempts,
    ).toHaveLength(2);
  });

  it('saves bytes under a safe name', async () => {
    const { model: m, save } = model();
    const result = await m.saveFile({
      suggestedName: '../x.png',
      extension: 'png',
      base64: Buffer.from('hello').toString('base64'),
    });
    expect(result).toEqual({ ok: true });
    expect(save).toHaveBeenCalledTimes(1);
    const [name, extension, bytes] = save.mock.calls[0] as unknown as [string, string, Uint8Array];
    expect(name).toBe('_x.png');
    expect(extension).toBe('png');
    expect(Buffer.from(bytes).toString()).toBe('hello');
  });

  it('passes on a cancelled or failed save', async () => {
    const params = { suggestedName: 'a', extension: 'png', base64: 'AAAA' };
    expect(
      await model(vi.fn((): Promise<Outcome> => Promise.resolve('cancelled'))).model.saveFile(
        params,
      ),
    ).toEqual({
      ok: false,
      error: 'cancelled',
    });
    expect(
      await model(vi.fn((): Promise<Outcome> => Promise.resolve('failed'))).model.saveFile(params),
    ).toEqual({
      ok: false,
      error: 'failed',
    });
  });

  it('refuses text that is not Base64, without asking where to save', async () => {
    const { model: m, save } = model();
    expect(
      await m.saveFile({ suggestedName: 'a', extension: 'png', base64: 'not base64!' }),
    ).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(await m.saveFile({ suggestedName: 'a', extension: 'png', base64: 'A' })).toEqual({
      ok: false,
      error: 'invalid',
    });
    expect(save).not.toHaveBeenCalled();
  });
});
