import { cleanup, fireEvent, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeQr } from '../../../../../src/shared/tools/qr/encode';
import { qrToPixels } from '../../../../../src/shared/tools/qr/render';
import { flush } from '../../../../helpers/rpc';
import { chooseFile, fakeCanvas, field, openTools } from '../../../../helpers/webview/tools-page';

afterEach(cleanup);

const picture = (text: string) => qrToPixels(encodeQr(text), 4, { margin: 4 });

describe('QR tab: reading', () => {
  it('reads a code from a picked picture and shows its content and version', async () => {
    const canvas = fakeCanvas({ pixels: () => Promise.resolve(picture('hello from a QR code')) });
    await openTools({ canvas, tab: 'QR code' });
    await chooseFile();
    await waitFor(() => {
      expect(field('qr-content').value).toBe('hello from a QR code');
    });
    expect(screen.getByTestId('qr-version').textContent).toBe('Version 2');
    expect(screen.queryByTestId('qr-open')).toBeNull();
    expect(screen.getByTestId('qr-history').textContent).toContain('hello from a QR code');
  });

  it('says so when the picture has no code, or cannot be read', async () => {
    const blank = { width: 60, height: 60, data: new Uint8ClampedArray(60 * 60 * 4).fill(255) };
    await openTools({
      canvas: fakeCanvas({ pixels: () => Promise.resolve(blank) }),
      tab: 'QR code',
    });
    await chooseFile();
    expect((await screen.findByTestId('qr-none')).textContent).toContain('No QR code');
    cleanup();
    await openTools({
      canvas: fakeCanvas({ pixels: () => Promise.resolve(undefined) }),
      tab: 'QR code',
    });
    await chooseFile();
    expect((await screen.findByTestId('qr-none')).textContent).toContain('No QR code');
  });

  it('opens a link only through the host, which asks the user', async () => {
    const canvas = fakeCanvas({
      pixels: () => Promise.resolve(picture('https://example.com/a?b=1')),
    });
    const openLink = vi.fn((_: unknown) => ({ opened: false }));
    await openTools({
      canvas,
      tab: 'QR code',
      handle: (host) => {
        host.handle('openLink', openLink);
      },
    });
    await chooseFile();
    await fireEvent.click(await screen.findByTestId('qr-open'));
    await flush();
    expect(openLink).toHaveBeenCalledWith({ url: 'https://example.com/a?b=1' });
    expect((await screen.findByTestId('qr-note')).textContent).toContain('not opened');
  });

  it('offers no link button for text that is not a link', async () => {
    const canvas = fakeCanvas({ pixels: () => Promise.resolve(picture('javascript:alert(1)')) });
    await openTools({ canvas, tab: 'QR code' });
    await chooseFile();
    await screen.findByTestId('qr-content');
    expect(screen.queryByTestId('qr-open')).toBeNull();
  });

  it('keeps what it read in a list that can be shown again and cleared', async () => {
    const texts = ['first', 'second'];
    const canvas = fakeCanvas({ pixels: () => Promise.resolve(picture(texts.shift() ?? 'x')) });
    await openTools({ canvas, tab: 'QR code' });
    await chooseFile();
    await waitFor(() => {
      expect(field('qr-content').value).toBe('first');
    });
    await chooseFile('two.png');
    await waitFor(() => {
      expect(field('qr-content').value).toBe('second');
    });
    const list = screen.getByTestId('qr-history');
    expect([...list.querySelectorAll('li')].map((li) => li.textContent.trim())).toEqual([
      'second',
      'first',
    ]);
    await fireEvent.click(list.querySelectorAll('button')[1] as HTMLElement);
    expect(field('qr-content').value).toBe('first');
    await fireEvent.click(screen.getByRole('button', { name: 'Clear the list' }));
    expect(screen.queryByTestId('qr-history')).toBeNull();
  });

  it('puts the content into the text to make a new code from', async () => {
    const canvas = fakeCanvas({ pixels: () => Promise.resolve(picture('reuse me')) });
    await openTools({ canvas, tab: 'QR code' });
    await chooseFile();
    await fireEvent.click(await screen.findByTestId('qr-reuse'));
    expect(field('qr-source').value).toBe('reuse me');
  });

  it('copies the content through the host', async () => {
    const canvas = fakeCanvas({ pixels: () => Promise.resolve(picture('copy me')) });
    const { copied } = await openTools({ canvas, tab: 'QR code' });
    await chooseFile();
    await screen.findByTestId('qr-content');
    await fireEvent.click(screen.getByRole('button', { name: 'Copy Content' }));
    await flush();
    expect(copied).toHaveBeenCalledWith({ text: 'copy me' });
  });
});

describe('QR tab: making', () => {
  it('draws a preview of the text and says the version and size', async () => {
    await openTools({ tab: 'QR code' });
    const preview = screen.getByTestId<HTMLImageElement>('qr-preview');
    expect(preview.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(screen.getByTestId('qr-info').textContent).toContain('Version 2 · 25×25');
    await fireEvent.input(field('qr-source'), {
      target: { value: 'a much longer text '.repeat(10) },
    });
    await waitFor(() => {
      expect(screen.getByTestId('qr-info').textContent).not.toContain('25×25');
    });
  });

  it('follows the error correction level', async () => {
    await openTools({ tab: 'QR code' });
    const text = 'x'.repeat(30);
    await fireEvent.input(field('qr-source'), { target: { value: text } });
    const sizeAt = (): string => screen.getByTestId('qr-info').textContent;
    await fireEvent.click(screen.getByTestId('qr-ecc-L'));
    const low = sizeAt();
    await fireEvent.click(screen.getByTestId('qr-ecc-H'));
    expect(sizeAt()).not.toBe(low);
    expect(screen.getByTestId('qr-ecc-H').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('qr-ecc-L').getAttribute('aria-pressed')).toBe('false');
  });

  it('refuses a text that does not fit', async () => {
    await openTools({ tab: 'QR code' });
    await fireEvent.input(field('qr-source'), { target: { value: 'z'.repeat(4000) } });
    expect((await screen.findByTestId('qr-problem')).textContent).toContain('too long');
    expect(screen.queryByTestId('qr-preview')).toBeNull();
    expect(screen.queryByTestId('qr-save-png')).toBeNull();
  });

  it('warns about colours that are too close, and about an inverted code', async () => {
    await openTools({ tab: 'QR code' });
    expect(screen.queryByTestId('qr-warning')).toBeNull();
    await fireEvent.input(field('qr-dark'), { target: { value: '#777777' } });
    await fireEvent.input(field('qr-light'), { target: { value: '#888888' } });
    expect((await screen.findByTestId('qr-warning')).textContent).toContain('too close');
    await fireEvent.input(field('qr-dark'), { target: { value: '#ffffff' } });
    await fireEvent.input(field('qr-light'), { target: { value: '#000000' } });
    await waitFor(() => {
      expect(screen.getByTestId('qr-warning').textContent).toContain('Light on dark');
    });
  });

  it('saves a PNG of the chosen size through the host', async () => {
    const fromPixels = vi.fn(() => Promise.resolve('data:image/png;base64,UE5H'));
    const { saveFile } = await openTools({ canvas: fakeCanvas({ fromPixels }), tab: 'QR code' });
    await fireEvent.input(field('qr-size'), { target: { value: '500' } });
    await fireEvent.click(screen.getByTestId('qr-save-png'));
    await flush();
    expect(fromPixels).toHaveBeenCalledTimes(1);
    const sent = fromPixels.mock.calls[0] as unknown as [{ width: number }];
    // 25 modules + 8 of quiet zone is 33; 500 / 33 rounds to 15 pixels a module.
    expect(sent[0].width).toBe(33 * 15);
    expect(saveFile).toHaveBeenCalledWith({
      suggestedName: 'qrcode',
      extension: 'png',
      base64: 'UE5H',
    });
    expect((await screen.findByTestId('qr-note')).textContent).toContain('saved');
  });

  it('saves the SVG text through the host', async () => {
    const { saveFile } = await openTools({ tab: 'QR code' });
    await fireEvent.click(screen.getByTestId('qr-save-svg'));
    await flush();
    const call = saveFile.mock.calls[0]?.[0] as { extension: string; base64: string };
    expect(call.extension).toBe('svg');
    expect(atob(call.base64).startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true);
  });

  it('is quiet when the save is cancelled and says so when it fails', async () => {
    const { saveFile } = await openTools({ tab: 'QR code' });
    saveFile.mockReturnValueOnce({ ok: false, error: 'cancelled' });
    await fireEvent.click(screen.getByTestId('qr-save-svg'));
    await flush();
    expect(screen.queryByTestId('qr-note')).toBeNull();
    saveFile.mockReturnValueOnce({ ok: false, error: 'failed' });
    await fireEvent.click(screen.getByTestId('qr-save-svg'));
    expect((await screen.findByTestId('qr-note')).textContent).toContain('could not be saved');
  });

  it('copies the SVG as text and the image through the canvas, and says when it cannot', async () => {
    const copyImage = vi.fn(() => Promise.resolve(false));
    const { copied } = await openTools({ canvas: fakeCanvas({ copyImage }), tab: 'QR code' });
    await fireEvent.click(screen.getByRole('button', { name: 'Copy SVG' }));
    await flush();
    expect((copied.mock.calls[0]?.[0] as { text: string }).text.startsWith('<svg')).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Copy the image' }));
    expect((await screen.findByTestId('qr-note')).textContent).toContain('did not let the page');
    expect(copyImage).toHaveBeenCalledOnce();
  });
});
