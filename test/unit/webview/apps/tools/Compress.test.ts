import { cleanup, fireEvent, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flush } from '../../../../helpers/rpc';
import {
  fakeCanvas,
  fakeImages,
  field,
  openTools,
  type HostPeer,
} from '../../../../helpers/webview/tools-page';

afterEach(cleanup);

/** A picture with this many bytes in its file. */
async function pickBytes(size: number, name = 'photo.png', type = 'image/png'): Promise<void> {
  const file = new File(['x'.repeat(size)], name, { type });
  await fireEvent.change(screen.getByTestId('file'), { target: { files: [file] } });
  await flush();
}

async function openCompress(over: Parameters<typeof openTools>[0] = {}) {
  const opened = await openTools({ tab: 'Image', ...over });
  await fireEvent.click(screen.getByTestId('mode-compress'));
  return opened;
}

const gradient = (side: number) => {
  const data = new Uint8ClampedArray(side * side * 4);
  for (let i = 0; i < side * side; i++) {
    data.set([(i * 7) % 256, (i * 13) % 256, (i * 29) % 256, 255], i * 4);
  }
  return { width: side, height: side, data };
};

describe('Compress: on this machine', () => {
  it('shows a palette of colours for a PNG, and a quality slider for a JPEG', async () => {
    await openCompress();
    await pickBytes(2000);
    expect(screen.getByTestId('comp-colours-256').getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('comp-quality')).toBeNull();
    cleanup();
    await openCompress();
    await pickBytes(2000, 'photo.jpg', 'image/jpeg');
    expect(screen.getByTestId('comp-quality')).toBeTruthy();
    expect(screen.queryByTestId('comp-colours-256')).toBeNull();
  });

  it('writes a smaller indexed PNG and says how much it saved', async () => {
    const deflate = vi.fn((bytes: Uint8Array) => Promise.resolve(bytes.subarray(0, 40)));
    const pixels = vi.fn(() => Promise.resolve(gradient(8)));
    const { saveFile } = await openCompress({ canvas: fakeCanvas({ pixels, deflate }) });
    await pickBytes(20_000);
    await fireEvent.click(screen.getByTestId('comp-colours-16'));
    await fireEvent.click(screen.getByTestId('comp-run'));
    await screen.findByTestId('comp-result');
    expect(pixels).toHaveBeenCalledWith(expect.stringContaining('data:image/png'), 200, true);
    expect(deflate).toHaveBeenCalledOnce();
    expect(screen.getByTestId('comp-before').textContent).toBe('20 KB');
    expect(
      Number(screen.getByTestId('comp-saved').textContent.replace(/[^\d]/gu, '')),
    ).toBeGreaterThan(90);
    expect(screen.getByTestId('comp-saved').className).toContain('success');
    await fireEvent.click(screen.getByTestId('comp-save'));
    await flush();
    const sent = saveFile.mock.calls[0]?.[0] as {
      suggestedName: string;
      extension: string;
      base64: string;
    };
    expect(sent.suggestedName).toBe('photo-min');
    expect(sent.extension).toBe('png');
    expect(atob(sent.base64).startsWith('\x89PNG')).toBe(true);
  });

  it('says when the result is not smaller', async () => {
    await openCompress({ canvas: fakeCanvas({ pixels: () => Promise.resolve(gradient(8)) }) });
    await pickBytes(10);
    await fireEvent.click(screen.getByTestId('comp-run'));
    await screen.findByTestId('comp-result');
    expect(screen.getByTestId('comp-saved').textContent).toContain('Not smaller');
  });

  it('re-encodes a JPEG at the chosen quality', async () => {
    const render = vi.fn((_url: string, options: { format: string }) =>
      Promise.resolve(`data:image/${options.format};base64,QUJD`),
    );
    const { saveFile } = await openCompress({ images: fakeImages({ render }) });
    await pickBytes(9000, 'shot.jpg', 'image/jpeg');
    await fireEvent.input(field('comp-quality'), { target: { value: '40' } });
    await fireEvent.click(screen.getByTestId('comp-run'));
    await screen.findByTestId('comp-result');
    expect(render).toHaveBeenCalledWith(expect.any(String), {
      width: 200,
      height: 100,
      format: 'jpeg',
      quality: 0.4,
      background: '#ffffff',
    });
    expect(screen.getByTestId('comp-after').textContent).toBe('3 B');
    await fireEvent.click(screen.getByTestId('comp-save'));
    await flush();
    expect(saveFile).toHaveBeenCalledWith({
      suggestedName: 'shot-min',
      extension: 'jpg',
      base64: 'QUJD',
    });
  });

  it('says so when the editor cannot write WebP, or the picture is too big', async () => {
    await openCompress({ images: fakeImages({ render: () => Promise.resolve(undefined) }) });
    await pickBytes(9000, 'a.webp', 'image/webp');
    await fireEvent.click(screen.getByTestId('comp-run'));
    expect((await screen.findByTestId('comp-problem')).textContent).toContain('cannot write WEBP');
    cleanup();
    await openCompress({ images: fakeImages({}, { width: 8000, height: 8000 }) });
    await pickBytes(100);
    await fireEvent.click(screen.getByTestId('comp-run'));
    expect((await screen.findByTestId('comp-problem')).textContent).toContain('too many pixels');
  });

  it('says so when a picture has too many pixels to reduce here, or cannot be read', async () => {
    await openCompress({ images: fakeImages({}, { width: 4000, height: 3000 }) });
    await pickBytes(100);
    await fireEvent.click(screen.getByTestId('comp-run'));
    expect((await screen.findByTestId('comp-problem')).textContent).toContain('too big to reduce');
    cleanup();
    await openCompress({ canvas: fakeCanvas({ pixels: () => Promise.resolve(undefined) }) });
    await pickBytes(100);
    await fireEvent.click(screen.getByTestId('comp-run'));
    expect((await screen.findByTestId('comp-problem')).textContent).toContain('not an image');
  });

  it('turns an unexpected failure into a message', async () => {
    await openCompress({ canvas: fakeCanvas({ pixels: () => Promise.reject(new Error('boom')) }) });
    await pickBytes(100);
    await fireEvent.click(screen.getByTestId('comp-run'));
    expect((await screen.findByTestId('comp-problem')).textContent).toContain(
      'could not be compressed',
    );
    expect(screen.getByTestId<HTMLButtonElement>('comp-run').disabled).toBe(false);
  });

  it('cannot run without a picture', async () => {
    await openCompress();
    expect(screen.getByTestId<HTMLButtonElement>('comp-run').disabled).toBe(true);
    expect(screen.getByText('Choose an image first')).toBeTruthy();
  });
});

describe('Compress: TinyPNG', () => {
  const handlers = (
    host: HostPeer,
    over: {
      saved?: boolean;
      answer?: {
        ok: boolean;
        base64?: string;
        count?: number;
        error?: 'limit' | 'unauthorized' | 'network' | 'unsupported';
      };
    } = {},
  ) => {
    let saved = over.saved ?? false;
    const save = vi.fn(({ key }: { key: string }) => {
      if (key.length < 8) {
        return { ok: false, error: 'invalid' as const };
      }
      saved = true;
      return { ok: true };
    });
    const forget = vi.fn(() => {
      saved = false;
      return { ok: true };
    });
    const compress = vi.fn((_: unknown) => over.answer ?? { ok: true, base64: 'AQ==', count: 12 });
    host.handle('tinyStatus', () => ({ saved }));
    host.handle('tinySaveKey', save);
    host.handle('tinyForgetKey', forget);
    host.handle('tinyCompress', compress);
    return { save, forget, compress };
  };

  it('says the picture will be sent, and asks for a key first', async () => {
    await openCompress();
    await fireEvent.click(screen.getByTestId('comp-tiny'));
    expect(screen.getByTestId('comp-privacy').textContent).toContain('sent to TinyPNG');
    expect(field('comp-key').type).toBe('password');
    expect(screen.getByTestId<HTMLButtonElement>('comp-save-key').disabled).toBe(true);
    await pickBytes(100);
    expect(screen.getByTestId<HTMLButtonElement>('comp-run').disabled).toBe(true);
  });

  it('saves the key through the host and forgets it again', async () => {
    let calls: ReturnType<typeof handlers> | undefined;
    await openCompress({
      handle: (host) => {
        calls = handlers(host);
      },
    });
    await fireEvent.click(screen.getByTestId('comp-tiny'));
    await fireEvent.input(field('comp-key'), { target: { value: 'short' } });
    await fireEvent.click(screen.getByTestId('comp-save-key'));
    expect((await screen.findByTestId('comp-problem')).textContent).toContain('does not look like');
    await fireEvent.input(field('comp-key'), { target: { value: 'abcd1234efgh' } });
    await fireEvent.click(screen.getByTestId('comp-save-key'));
    await screen.findByTestId('comp-key-saved');
    expect(calls?.save).toHaveBeenLastCalledWith({ key: 'abcd1234efgh' });
    expect(screen.queryByTestId('comp-key')).toBeNull();
    expect(screen.queryByTestId('comp-problem')).toBeNull();
    await fireEvent.click(screen.getByTestId('comp-forget'));
    await screen.findByTestId('comp-key');
    expect(calls?.forget).toHaveBeenCalledOnce();
  });

  it('knows about a key saved earlier', async () => {
    await openCompress({
      handle: (host) => {
        handlers(host, { saved: true });
      },
    });
    await fireEvent.click(screen.getByTestId('comp-tiny'));
    await screen.findByTestId('comp-key-saved');
  });

  it('sends the picture and shows the answer with the number of compressions', async () => {
    let calls: ReturnType<typeof handlers> | undefined;
    const { saveFile } = await openCompress({
      handle: (host) => {
        calls = handlers(host, { saved: true });
      },
    });
    await fireEvent.click(screen.getByTestId('comp-tiny'));
    await pickBytes(5000);
    await fireEvent.click(screen.getByTestId('comp-run'));
    await screen.findByTestId('comp-result');
    expect(calls?.compress).toHaveBeenCalledWith({ base64: 'iVBORw0KGgo=', mime: 'image/png' });
    expect(screen.getByTestId('comp-count').textContent).toContain('12');
    expect(screen.getByTestId('comp-after').textContent).toBe('1 B');
    await fireEvent.click(screen.getByTestId('comp-save'));
    await flush();
    expect(saveFile).toHaveBeenCalledWith({
      suggestedName: 'photo-min',
      extension: 'png',
      base64: 'AQ==',
    });
  });

  it('explains what TinyPNG answered when it did not shrink the picture', async () => {
    for (const [error, text] of [
      ['limit', 'monthly limit'],
      ['unauthorized', 'did not accept'],
      ['network', 'could not be reached'],
      ['unsupported', 'takes PNG'],
    ] as const) {
      await openCompress({
        handle: (host) => {
          handlers(host, { saved: true, answer: { ok: false, error } });
        },
      });
      await fireEvent.click(screen.getByTestId('comp-tiny'));
      await pickBytes(100);
      await fireEvent.click(screen.getByTestId('comp-run'));
      const problem = await screen.findByTestId('comp-problem').catch(() => {
        throw new Error(`no message for ${error}`);
      });
      expect(problem.textContent, error).toContain(text);
      cleanup();
    }
  });

  it('does not send a picture TinyPNG cannot take, or one that is too big', async () => {
    let calls: ReturnType<typeof handlers> | undefined;
    await openCompress({
      images: fakeImages({
        load: (file, name) =>
          Promise.resolve({
            dataUrl: 'data:image/gif;base64,R0lGODlh',
            width: 2,
            height: 2,
            name,
            bytes: file.size,
            mime: 'image/gif',
          }),
      }),
      handle: (host) => {
        calls = handlers(host, { saved: true });
      },
    });
    await fireEvent.click(screen.getByTestId('comp-tiny'));
    await pickBytes(100, 'a.gif', 'image/gif');
    await fireEvent.click(screen.getByTestId('comp-run'));
    expect((await screen.findByTestId('comp-problem')).textContent).toContain('takes PNG');
    cleanup();
    await openCompress({
      images: fakeImages({
        load: (file, name) =>
          Promise.resolve({
            dataUrl: `data:image/png;base64,${'A'.repeat(7_000_000)}`,
            width: 9,
            height: 9,
            name,
            bytes: file.size,
            mime: 'image/png',
          }),
      }),
      handle: (host) => {
        calls = handlers(host, { saved: true });
      },
    });
    await fireEvent.click(screen.getByTestId('comp-tiny'));
    await pickBytes(100);
    await fireEvent.click(screen.getByTestId('comp-run'));
    await waitFor(() => {
      expect(screen.getByTestId('comp-problem').textContent).toContain('up to 5 MB');
    });
    expect(calls?.compress).not.toHaveBeenCalled();
  });
});
